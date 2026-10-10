"""Test fixtures.

Tests run against the real Postgres from DATABASE_URL, in a throwaway
schema. The grant predicate is SQL, so testing it against anything other
than Postgres would test the wrong thing.

Isolation works by pointing every connection at a test schema via libpq's
`options=-csearch_path=...`, because db.py opens a fresh connection per
call -- so data must be committed to be visible to the code under test.
Tables are truncated between tests, and the schema is dropped at the end.
"""
from __future__ import annotations

import os
import uuid
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from urllib.parse import quote

import pytest

SYS = "test@cloudminds"
SCHEMA = f"t_{uuid.uuid4().hex[:10]}"
MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations"

TABLES = [
    "fact_cost_daily", "ingest_runs", "anomaly_findings",
    "alert_events", "alert_rules", "cloud_connections",
    "access_grants", "identities", "users", "audit_log",
    "dim_account", "dim_service",
]


def _with_schema(url: str, schema: str) -> str:
    """Pin every new connection to `schema` (then public, for extensions)."""
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}options={quote(f'-csearch_path={schema},public')}"


@pytest.fixture(scope="session", autouse=True)
def schema():
    """Create an isolated schema, migrate into it, drop it afterwards."""
    import psycopg

    from cloudminds.config import settings

    # Read through settings, not os.environ: in dev the URL comes from .env.
    try:
        base = settings().database_url
    except Exception:
        pytest.skip("DATABASE_URL not configured")

    with psycopg.connect(base, autocommit=True) as conn:
        conn.execute(f'CREATE SCHEMA "{SCHEMA}"')

    # Pin the app's connections to the test schema. An env var overrides
    # .env in pydantic-settings, so this wins once the cache is cleared.
    os.environ["DATABASE_URL"] = _with_schema(base, SCHEMA)
    settings.cache_clear()

    from cloudminds.db import connect, reset_pool

    reset_pool()  # rebuild against the schema-pinned URL

    with connect() as conn, conn.cursor() as cur:
        for path in sorted(MIGRATIONS.glob("*.sql")):
            cur.execute(path.read_text(encoding="utf-8"))

    yield SCHEMA

    reset_pool()
    with psycopg.connect(base, autocommit=True) as conn:
        conn.execute(f'DROP SCHEMA "{SCHEMA}" CASCADE')


@pytest.fixture(autouse=True)
def clean(schema):
    """Empty every table before each test.

    TRUNCATE rather than DELETE: audit_log carries a BEFORE DELETE trigger
    enforcing append-only (migration 005), and TRUNCATE does not fire it.
    """
    from cloudminds.db import connect

    with connect() as conn, conn.cursor() as cur:
        cur.execute(f"TRUNCATE {', '.join(TABLES)} RESTART IDENTITY CASCADE")
    yield


@pytest.fixture
def exec_sql():
    """Run a statement in its own committed transaction."""
    from cloudminds.db import connect

    def _exec(sql: str, params: dict | None = None):
        with connect() as conn, conn.cursor() as cur:
            cur.execute(sql, params or {})
            try:
                return cur.fetchone()
            except Exception:
                return None

    return _exec


@pytest.fixture
def make_user(exec_sql):
    def _make(email: str, role: str = "user") -> str:
        row = exec_sql(
            """
            INSERT INTO users (email, role, status, created_by, updated_by)
            VALUES (%(e)s, %(r)s, 'active', %(s)s, %(s)s)
            RETURNING id
            """,
            {"e": email, "r": role, "s": SYS},
        )
        return str(row["id"])

    return _make


@pytest.fixture
def make_grant(exec_sql):
    def _make(
        user_id: str,
        account_id: str,
        service_name: str | None = None,
        *,
        provider: str = "aws",
        valid_from=None,
        valid_until=None,
        revoked: bool = False,
    ) -> str:
        row = exec_sql(
            """
            INSERT INTO access_grants
              (user_id, provider, account_id, service_name,
               valid_from, valid_until, revoked_at, created_by, updated_by)
            VALUES
              (%(u)s, %(p)s, %(a)s, %(sv)s,
               COALESCE(%(vf)s, now()), %(vu)s,
               CASE WHEN %(rv)s THEN now() ELSE NULL END, %(s)s, %(s)s)
            RETURNING id
            """,
            {
                "u": user_id, "p": provider, "a": account_id, "sv": service_name,
                "vf": valid_from, "vu": valid_until, "rv": revoked, "s": SYS,
            },
        )
        return str(row["id"])

    return _make


@pytest.fixture
def make_facts(exec_sql):
    """Insert cost rows, exercising ingest_runs lineage as well."""

    def _make(
        rows: list[tuple[str, str, Decimal | float]],
        *,
        provider: str = "aws",
        on: date | None = None,
        charge_category: str = "Usage",
    ) -> str:
        on = on or date.today() - timedelta(days=1)
        run = exec_sql(
            """
            INSERT INTO ingest_runs
              (source, provider, period_start, period_end, status,
               triggered_by, created_by, updated_by)
            VALUES ('test', %(p)s, %(d)s, %(d)s, 'success', %(s)s, %(s)s, %(s)s)
            RETURNING id
            """,
            {"p": provider, "d": on, "s": SYS},
        )
        run_id = run["id"]

        for account_id, service_name, cost in rows:
            exec_sql(
                """
                INSERT INTO fact_cost_daily
                  (provider, account_id, service_name, region, charge_category,
                   usage_date, billed_cost, effective_cost, currency,
                   ingest_run_id, source, created_by, updated_by)
                VALUES
                  (%(p)s, %(a)s, %(sv)s, 'us-east-1', %(cc)s, %(d)s,
                   %(c)s, %(c)s, 'USD', %(r)s, 'test', %(s)s, %(s)s)
                """,
                {
                    "p": provider, "a": account_id, "sv": service_name,
                    "cc": charge_category, "d": on,
                    "c": Decimal(str(cost)), "r": run_id, "s": SYS,
                },
            )
        return str(run_id)

    return _make
