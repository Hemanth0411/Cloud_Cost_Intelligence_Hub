"""Runs left `running` by a process that died, and the import window.

Two findings from one audit, both about the on-demand import and its
29-second budget.

The first: `_start_run` commits before fetching, `_finish_run` only runs
if the process is still alive to call it. A timeout kills the process.
So the run stayed `running` forever and the connection went on showing
the success from BEFORE the attempt that died. Nothing reconciled it.

The second: the cap on `days` was justified by "a window inside a single
month is one Cost Explorer call". The window is never inside a single
month at the cap, and often is not at the default either. The last two
tests pin the real arithmetic, so the comment that replaced that claim
cannot drift away from the code it describes.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from costhub.connections import store
from costhub.connections.credentials import Connection
from costhub.db import execute, fetch_all
from costhub.ingest import runner, stale
from costhub.ingest.cost_explorer import _monthly_windows, default_window
from costhub.ingest.ports import CostRow

ACTOR = "tester@costhub"


def _connection() -> Connection:
    cid = store.upsert(
        actor=ACTOR,
        provider="aws",
        account_id="444455556666",
        display_name="Timeouts",
        credential_mode="assume_role",
        role_arn="arn:aws:iam::444455556666:role/CostHubCostReader",
    )
    conn = store.get(cid)
    assert conn is not None
    return conn


def _run(conn: Connection, *, minutes_ago: int) -> str:
    run_id = runner._start_run(conn, "test", date(2026, 10, 1), date(2026, 10, 8), ACTOR)
    execute(
        "UPDATE ingest_runs SET started_at = now() - make_interval(mins => %(m)s) "
        "WHERE id = %(id)s",
        {"m": minutes_ago, "id": run_id},
    )
    return run_id


def _status(run_id: str) -> dict:
    return fetch_all(
        "SELECT status, error, finished_at, rows_written FROM ingest_runs WHERE id = %(id)s",
        {"id": run_id},
    )[0]


def _last(conn: Connection) -> dict:
    return fetch_all(
        "SELECT last_ingest_at, last_ingest_status FROM cloud_connections WHERE id = %(id)s",
        {"id": conn.id},
    )[0]


class _Killed(BaseException):
    """Stands in for the process being stopped.

    BaseException, not Exception, on purpose: the runner catches
    Exception and records a failure, which is the path that already
    worked. A Lambda timeout runs no handler at all, and the nearest
    thing in-process is an exception nothing catches.
    """


def test_a_killed_import_leaves_running_and_the_reaper_closes_it():
    """The whole finding, end to end through the real runner."""
    conn = _connection()
    store.record_ingest(connection_id=conn.id, status="success")  # the earlier, real one
    execute(
        "UPDATE cloud_connections SET last_ingest_at = now() - interval '1 day' WHERE id = %(i)s",
        {"i": conn.id},
    )

    class _DiesMidFetch:
        name = "test"

        def fetch(self, *, account_id, start, end):
            # One real row first, so "nothing half-written" below is a
            # claim about a transaction that had something in it.
            yield CostRow(
                provider="aws",
                account_id=account_id,
                service_name="AWS Glue",
                region="us-east-1",
                charge_category="Usage",
                usage_date=start,
                billed_cost="9.99",
                effective_cost="9.99",
                currency="USD",
            )
            raise _Killed()

    with pytest.raises(_Killed):
        runner.ingest(
            source_factory=lambda c: _DiesMidFetch(),
            start=date(2026, 10, 1),
            end=date(2026, 10, 8),
            triggered_by=ACTOR,
            connections=[conn],
        )

    # The state the audit described: stuck, and the connection lying.
    runs = fetch_all("SELECT id, status FROM ingest_runs WHERE connection_id = %(c)s", {"c": conn.id})
    assert [r["status"] for r in runs] == ["running"]
    assert _last(conn)["last_ingest_status"] == "success"
    assert fetch_all("SELECT 1 FROM fact_cost_daily WHERE account_id = '444455556666'") == []

    # Not yet: it could still be a live run.
    assert stale.reap_stale_runs() == 0
    assert _status(runs[0]["id"])["status"] == "running"

    execute(
        "UPDATE ingest_runs SET started_at = now() - make_interval(mins => %(m)s) WHERE id = %(id)s",
        {"m": stale.STALE_RUN_MINUTES + 1, "id": runs[0]["id"]},
    )
    assert stale.reap_stale_runs() == 1

    after = _status(runs[0]["id"])
    assert after["status"] == "failed"
    assert after["finished_at"] is not None
    assert after["rows_written"] == 0
    assert "Did not finish" in after["error"]
    assert _last(conn)["last_ingest_status"] == "failed"
    # Idempotent: a closed run is not closed again.
    assert stale.reap_stale_runs() == 0


def test_a_later_result_on_the_connection_is_not_overwritten():
    """A run died at T, another succeeded after it. The success is the
    truer status, and reaping the old one must not replace it."""
    conn = _connection()
    dead = _run(conn, minutes_ago=120)
    store.record_ingest(connection_id=conn.id, status="success")  # stamps now()

    assert stale.reap_stale_runs() == 1

    assert _status(dead)["status"] == "failed"
    assert _last(conn)["last_ingest_status"] == "success"


def test_the_next_ingest_closes_what_the_last_one_left_behind():
    conn = _connection()
    dead = _run(conn, minutes_ago=stale.STALE_RUN_MINUTES + 5)

    class _Empty:
        name = "test"

        def fetch(self, *, account_id, start, end):
            return iter(())

    runner.ingest(
        source_factory=lambda c: _Empty(),
        start=date(2026, 10, 1),
        end=date(2026, 10, 8),
        triggered_by=ACTOR,
        connections=[conn],
    )

    assert _status(dead)["status"] == "failed"
    assert _last(conn)["last_ingest_status"] == "success", "the new run finished after it"


def test_both_admin_listings_show_the_truth_without_waiting_for_an_ingest(as_superadmin):
    conn = _connection()
    dead = _run(conn, minutes_ago=stale.STALE_RUN_MINUTES + 5)
    live = _run(conn, minutes_ago=1)

    listed = as_superadmin.get("/admin/ingest-runs").json()["data"]
    by_id = {r["id"]: r for r in listed}
    assert by_id[dead]["status"] == "failed"
    assert "Did not finish" in by_id[dead]["error"]
    assert by_id[live]["status"] == "running", "a run that may still be alive is left alone"

    # And the other screen, on its own: reset, then ask only for connections.
    execute("UPDATE ingest_runs SET status = 'running', finished_at = NULL WHERE id = %(i)s", {"i": dead})
    execute(
        "UPDATE cloud_connections SET last_ingest_at = NULL, last_ingest_status = NULL WHERE id = %(i)s",
        {"i": conn.id},
    )
    rows = as_superadmin.get("/admin/connections").json()["data"]
    mine = next(r for r in rows if r["id"] == str(conn.id))
    assert mine["last_ingest_status"] == "failed"


# ------------------------------------------------- the import window

def _calls(today: date, days: int) -> int:
    """Cost Explorer calls (before pagination) for an import run on `today`.

    Through the real `default_window`, not a copy of its formula: the
    off-by-one in it is half of what these tests are about.
    """
    start, end = default_window(days, today=today)
    assert (end - start).days == days + 1, "`days` back, plus today"
    return len(list(_monthly_windows(start, end)))


def _every_day():
    d = date(2027, 1, 1)
    while d < date(2029, 1, 1):  # 2028 is a leap year
        yield d
        d += timedelta(days=1)


def test_the_cap_of_31_days_is_never_one_call_and_at_most_three():
    """What the route's docstring now says, checked over two years.

    The claim it replaced was that a capped import is one call.
    """
    counts = {today: _calls(today, 31) for today in _every_day()}

    assert min(counts.values()) == 2, "32 dates cannot fit in one month"
    assert max(counts.values()) == 3
    # Three whenever the month BEFORE this one is shorter than the
    # distance back to the window's first day: the 1st after any 30-day
    # month, and the first days of March. Written out, because the first
    # draft of the comment this pins said "early March only" and this
    # assertion is what caught it.
    three = sorted(d for d, n in counts.items() if n == 3)
    assert three == [
        date(2027, 3, 1), date(2027, 3, 2), date(2027, 3, 3),
        date(2027, 5, 1), date(2027, 7, 1), date(2027, 10, 1), date(2027, 12, 1),
        date(2028, 3, 1), date(2028, 3, 2),
        date(2028, 5, 1), date(2028, 7, 1), date(2028, 10, 1), date(2028, 12, 1),
    ]
    # No smaller window is worse, so 3 really is the ceiling for the route.
    assert max(_calls(t, d) for t in _every_day() for d in range(1, 32)) == 3


def test_the_default_week_is_two_calls_at_the_start_of_every_month():
    for today in _every_day():
        assert _calls(today, 7) == (2 if today.day <= 7 else 1), today


def test_reviving_a_connection_closes_what_its_previous_life_left_running(as_superadmin):
    """Where this finding and the revive one meet.

    An import hangs; the operator deletes the connection and registers
    it again, inside the fifteen minutes. The row comes back with no
    last import -- and then the reaper finds the old run, sees a
    connection that has never reported, and stamps it `failed`. A
    connection that has not run since it was registered must not say so.
    """
    body = {
        "provider": "aws",
        "account_id": "444455556666",
        "display_name": "Timeouts",
        "credential_mode": "assume_role",
        "role_arn": "arn:aws:iam::444455556666:role/CostHubCostReader",
    }
    conn = _connection()
    dead = _run(conn, minutes_ago=5)  # too young to reap when the delete happens

    as_superadmin.delete(f"/admin/connections/{conn.id}")
    assert as_superadmin.post("/admin/connections", json=body).status_code == 201
    assert _status(dead)["status"] == "failed", "closed by the revive itself"

    # Later, well past the threshold, somebody opens the screen.
    execute(
        "UPDATE ingest_runs SET started_at = now() - interval '2 hours' WHERE id = %(i)s",
        {"i": dead},
    )
    rows = as_superadmin.get("/admin/connections").json()["data"]
    mine = next(r for r in rows if r["id"] == str(conn.id))
    assert mine["last_ingest_status"] is None
