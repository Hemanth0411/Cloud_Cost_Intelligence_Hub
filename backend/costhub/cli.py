"""Operator commands.

    python -m costhub.cli bootstrap-admin --email you@chryselys.com
    python -m costhub.cli add-connection --account-id self --name personal
    python -m costhub.cli list-connections
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
from costhub.connections.credentials import Connection
from costhub.db import fetch_all
from costhub.ingest import runner
from costhub.ingest.cost_explorer import CostExplorerSource, default_window
from costhub.ingest.dev_seed import source_factory as dev_seed_factory
from costhub.ingest.dev_seed import planted_summary
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


def cmd_list_connections(_: argparse.Namespace) -> int:
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


def _run_ingest(start: date, end: date, dev_seed: bool) -> int:
    factory = dev_seed_factory if dev_seed else (lambda c: CostExplorerSource(c))
    results = runner.ingest(
        source_factory=factory, start=start, end=end, triggered_by=_actor()
    )
    print(f"window {start} .. {end}  source={'dev_seed' if dev_seed else 'cost_explorer'}")
    print(runner.summarize(results))
    if dev_seed:
        print(planted_summary())
    return 0 if all(r.ok for r in results) else 1


def cmd_ingest(args: argparse.Namespace) -> int:
    start, end = default_window(args.days)
    return _run_ingest(start, end, args.dev_seed)


def cmd_backfill(args: argparse.Namespace) -> int:
    end = date.today() + timedelta(days=1)
    start = date(end.year, end.month, 1)
    for _ in range(args.months):
        start = (start - timedelta(days=1)).replace(day=1)
    return _run_ingest(start, end, args.dev_seed)


def cmd_status(_: argparse.Namespace) -> int:
    rows = fetch_all(
        """
        SELECT provider, account_id, count(*) AS days,
               min(usage_date) AS first_day, max(usage_date) AS last_day,
               round(sum(effective_cost), 2) AS total
        FROM fact_cost_daily WHERE deleted_at IS NULL
        GROUP BY 1, 2 ORDER BY 1, 2
        """
    )
    if not rows:
        print("fact_cost_daily is empty — run ingest or backfill")
    for r in rows:
        print(
            f"  {r['provider']}/{r['account_id']:<14} "
            f"{r['first_day']} .. {r['last_day']}  "
            f"{r['days']:>6} rows  ${r['total']}"
        )
    runs = fetch_all(
        """
        SELECT source, status, rows_written, started_at, error
        FROM ingest_runs ORDER BY started_at DESC LIMIT 5
        """
    )
    if runs:
        print("\n  recent runs:")
        for r in runs:
            err = f"  {r['error'][:80]}" if r["error"] else ""
            print(
                f"    {r['started_at']:%Y-%m-%d %H:%M}  {r['source']:<14} "
                f"{r['status']:<8} {r['rows_written'] or 0:>6}{err}"
            )
    return 0


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
    a.set_defaults(fn=cmd_ingest)

    a = sub.add_parser("backfill")
    a.add_argument("--months", type=int, default=14)
    a.add_argument("--dev-seed", action="store_true")
    a.set_defaults(fn=cmd_backfill)

    sub.add_parser("status").set_defaults(fn=cmd_status)
    return p


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    args = build_parser().parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
