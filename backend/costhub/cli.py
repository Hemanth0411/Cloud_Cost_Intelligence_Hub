"""Operator commands.

    python -m costhub.cli bootstrap-admin --email you@chryselys.com
    python -m costhub.cli add-connection --account-id self --name personal
    python -m costhub.cli list-connections
    python -m costhub.cli rename-connection --account-id self --name Hemanth-AWS
    python -m costhub.cli grant --email a@chryselys.com --account-id self
    python -m costhub.cli ingest  [--days 7]  [--dev-seed]
    python -m costhub.cli backfill [--months 14] [--dev-seed]
    python -m costhub.cli status
"""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import date, timedelta

from costhub.config import settings
from costhub.connections import store
from costhub.ingest import report, runner
from costhub.ingest.cost_explorer import default_window
from costhub.ingest.stale import reap_stale_runs
from costhub.ingest.sources import dev_seed_for, source_for
from costhub.ingest.dev_seed import planted_summary
from costhub.cli_jobs import cmd_alerts, cmd_detect, cmd_status
from costhub.rbac import admin


def _actor() -> str:
    return settings().system_actor


# ------------------------------------------------------------------ commands

def cmd_bootstrap_admin(args: argparse.Namespace) -> int:
    uid = admin.invite_user(
        actor=_actor(), actor_role="superadmin",
        email=args.email, display_name=args.name,
    )
    # invite_user creates a 'user'; promote this one.
    from costhub.db import execute

    execute(
        "UPDATE users SET role='superadmin', status='active', updated_by=%(a)s "
        "WHERE id=%(id)s",
        {"id": uid, "a": _actor()},
    )
    print(f"superadmin: {args.email}  ({uid})")
    return 0


def cmd_add_connection(args: argparse.Namespace) -> int:
    mode = args.mode
    if mode is None:
        mode = "self" if args.account_id == "self" else (
            "profile" if args.profile else "assume_role"
        )
    cid = store.upsert(
        actor=_actor(),
        provider=args.provider,
        account_id=args.account_id,
        display_name=args.name,
        credential_mode=mode,
        role_arn=args.role_arn,
        external_id=args.external_id,
        profile_name=args.profile,
    )
    print(f"connection {args.provider}/{args.account_id} ({mode})  {cid}")
    return 0


def cmd_rename_connection(args: argparse.Namespace) -> int:
    """Relabel a connection without touching how it is reached.

    Deliberately not `add-connection` with a new --name: that path
    rewrites every credential column from its arguments, so it would
    blank the role ARN and the ExternalId of an assume_role connection
    unless both were re-supplied, and the ExternalId cannot be read back
    to re-supply.
    """
    cid = store.rename(
        actor=_actor(),
        provider=args.provider,
        account_id=args.account_id,
        display_name=args.name,
    )
    if cid is None:
        print(f"no connection {args.provider}/{args.account_id}")
        return 1
    print(f"renamed {args.provider}/{args.account_id} -> {args.name}  {cid}")
    return 0


def cmd_list_connections(_: argparse.Namespace) -> int:
    reap_stale_runs()  # `last=` below is only as true as the last run to report
    rows = store.list_connections()
    if not rows:
        print("no connections registered")
        return 0
    for r in rows:
        flag = "on " if r["enabled"] else "off"
        last = r["last_ingest_status"] or "-"
        print(
            f"  [{flag}] {r['provider']}/{r['account_id']:<14} "
            f"{r['display_name']:<12} {r['credential_mode']:<12} last={last}"
        )
    return 0


def cmd_grant(args: argparse.Namespace) -> int:
    gid = admin.grant(
        actor=_actor(), actor_role="superadmin",
        req=admin.GrantRequest(
            user_email=args.email,
            provider=args.provider,
            account_id=args.account_id,
            service_name=args.service,
            reason=args.reason,
        ),
    )
    scope = args.account_id + (f"/{args.service}" if args.service else " (all services)")
    print(f"granted {args.email} -> {scope}  ({gid})")
    return 0


def _run_ingest(
    start: date, end: date, dev_seed: bool, account_id: str | None = None
) -> int:
    factory = dev_seed_for if dev_seed else source_for

    # Scoped to one account when asked. `runner.ingest` consults
    # `store.enabled()` only when it is NOT handed an explicit list, so
    # the disabled check has to happen here too -- otherwise naming an
    # account would quietly bypass the switch the operator turned off.
    connections = None
    if account_id is not None:
        connections = [c for c in store.enabled() if c.account_id == account_id]
        if not connections:
            print(
                f"no enabled connection for account {account_id}. "
                "Run list-connections; a disabled or deleted one is skipped "
                "deliberately."
            )
            return 1

    results = runner.ingest(
        source_factory=factory,
        start=start,
        end=end,
        triggered_by=_actor(),
        connections=connections,
    )
    print(f"window {start} .. {end}  source={'dev_seed' if dev_seed else 'cost_explorer'}")
    print(report.summarize(results))
    if dev_seed:
        print(planted_summary())
    return 0 if all(r.ok for r in results) else 1


def cmd_ingest(args: argparse.Namespace) -> int:
    start, end = default_window(args.days)
    return _run_ingest(start, end, args.dev_seed, args.account_id)


# Cost Explorer keeps ~14 months of daily data. Asking for more does not
# return less -- it raises ValidationException, which (because fetch is a
# lazy generator consumed inside the write transaction) failed on the
# OLDEST chunk and left the whole connection with zero rows.
CE_MAX_MONTHS = 14
# A hard floor in DAYS as well as months. Month arithmetic alone still
# reached 426 days on a month-end -- right on the retention boundary --
# because `end` crosses into the next month. 400 leaves real headroom.
CE_MAX_DAYS = 400


def cmd_backfill(args: argparse.Namespace) -> int:
    months = max(1, min(args.months, CE_MAX_MONTHS))
    today = date.today()
    end = today + timedelta(days=1)          # exclusive, as ingest expects

    # Anchor on TODAY, not on `end`: anchoring on tomorrow shifted the
    # whole window forward a month on the last day of a month, so
    # --months 14 meant different things on different days.
    start = today.replace(day=1)
    for _ in range(months - 1):               # months-1: the current month counts
        start = (start - timedelta(days=1)).replace(day=1)

    floor = today - timedelta(days=CE_MAX_DAYS)
    clamped = start < floor
    if clamped and not args.dev_seed:
        start = floor

    if not args.dev_seed and (clamped or months != args.months):
        print(
            f"note: window clamped to {start}; Cost Explorer keeps ~"
            f"{CE_MAX_MONTHS} months of daily data and rejects older ranges "
            f"outright rather than returning less."
        )

    return _run_ingest(start, end, args.dev_seed, args.account_id)


# -------------------------------------------------------------------- parser

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="costhub")
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("bootstrap-admin")
    a.add_argument("--email", required=True)
    a.add_argument("--name", default=None)
    a.set_defaults(fn=cmd_bootstrap_admin)

    a = sub.add_parser("add-connection")
    a.add_argument("--provider", default="aws")
    a.add_argument("--account-id", required=True, help="'self' for the deploy account")
    a.add_argument("--name", required=True)
    a.add_argument("--mode", default=None,
                   choices=["self", "assume_role", "profile", "secret"])
    a.add_argument("--role-arn", default=None)
    a.add_argument("--external-id", default=None)
    a.add_argument("--profile", default=None, help="local AWS CLI profile")
    a.set_defaults(fn=cmd_add_connection)

    sub.add_parser("list-connections").set_defaults(fn=cmd_list_connections)

    a = sub.add_parser("rename-connection")
    a.add_argument("--provider", default="aws")
    a.add_argument("--account-id", required=True)
    a.add_argument("--name", required=True, help="the new display name")
    a.set_defaults(fn=cmd_rename_connection)

    a = sub.add_parser("grant")
    a.add_argument("--email", required=True)
    a.add_argument("--provider", default="aws")
    a.add_argument("--account-id", required=True)
    a.add_argument("--service", default=None, help="omit for all services")
    a.add_argument("--reason", default=None)
    a.set_defaults(fn=cmd_grant)

    a = sub.add_parser("ingest")
    a.add_argument("--days", type=int, default=7)
    a.add_argument("--dev-seed", action="store_true")
    a.add_argument("--account-id", default=None,
                   help="only this account; omit for every enabled connection")
    a.set_defaults(fn=cmd_ingest)

    a = sub.add_parser("backfill")
    a.add_argument("--months", type=int, default=14)
    a.add_argument("--dev-seed", action="store_true")
    a.add_argument("--account-id", default=None,
                   help="only this account; omit for every enabled connection")
    a.set_defaults(fn=cmd_backfill)

    a = sub.add_parser("detect")
    a.add_argument("--lookback", type=int, default=120)
    a.add_argument("--scan-days", type=int, default=7)
    a.add_argument("--exclude-recent", type=int, default=2)
    a.add_argument("--threshold", type=float, default=3.5)
    a.set_defaults(fn=cmd_detect)

    a = sub.add_parser("alerts")
    a.add_argument("--feed", action="store_true", help="show recent events")
    a.set_defaults(fn=cmd_alerts)

    sub.add_parser("status").set_defaults(fn=cmd_status)
    return p


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    args = build_parser().parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
