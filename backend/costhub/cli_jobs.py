"""CLI commands for the scheduled jobs: detect, alerts, status.

Split out of cli.py purely to keep both files inside the 300-line limit
(NFR-18). The parser and dispatch stay in cli.py so `python -m
costhub.cli` keeps working.
"""
from __future__ import annotations

import argparse
from datetime import timedelta

from costhub.alerts import runner as alert_runner
from costhub.anomaly import runner as anomaly_runner
from costhub.db import fetch_all

# Cost Explorer keeps ~14 months of daily data, so status looks no
# further back than the backfill could have reached.
CE_MAX_DAYS = 400


def cmd_detect(args: argparse.Namespace) -> int:
    from costhub.anomaly.mad import MadDetector

    det = MadDetector(
        exclude_recent_days=args.exclude_recent,
        scan_days=args.scan_days,
        z_threshold=args.threshold,
    )
    result = anomaly_runner.scan(detector=det, lookback_days=args.lookback)
    print(result)

    rows = fetch_all(
        """
        SELECT account_id, service_name, detected_for_date, kind,
               baseline_value, observed_value, delta_abs, delta_pct, score
        FROM anomaly_findings WHERE status = 'new'
        ORDER BY abs(delta_abs) DESC LIMIT 20
        """
    )
    for r in rows:
        pct = f"{r['delta_pct']:+.0f}%" if r["delta_pct"] is not None else "  new"
        print(
            f"  {r['kind']:<6} {r['account_id']:<14} {r['service_name']:<18} "
            f"{r['detected_for_date']}  "
            f"${r['baseline_value']:.2f} -> ${r['observed_value']:.2f}  "
            f"{pct:>7}  z={r['score']:.1f}"
        )
    return 0


def cmd_alerts(args: argparse.Namespace) -> int:
    result = alert_runner.run()
    print(result)
    for line in result.details:
        print(f"  {line}")
    if args.feed:
        rows = fetch_all(
            """
            SELECT r.name, e.fired_at, e.observed_value, e.status,
                   e.delivered_at, e.delivery_error
            FROM alert_events e JOIN alert_rules r ON r.id = e.rule_id
            ORDER BY e.fired_at DESC LIMIT 10
            """
        )
        print()
        print("  feed:")
        for r in rows:
            mark = "sent" if r["delivered_at"] else "HELD"
            val = f"${r['observed_value']:,.2f}" if r["observed_value"] is not None else "-"
            note = f"  {r['delivery_error'][:70]}" if r["delivery_error"] else ""
            print(f"    {r['fired_at']:%m-%d %H:%M} {mark} {r['name']:<22} {val:>12}{note}")
    return 0


def cmd_status(_: argparse.Namespace) -> int:
    # Through query/scoped as the system principal, not a direct SELECT:
    # cmd_status was one of the two readers that quietly falsified the
    # single-enforcement-point invariant. test_invariant.py now fails the
    # build if it comes back.
    from datetime import date as _date

    from costhub.query import scoped

    rows = scoped.all_series(
        scoped.system_principal(),
        start=_date.today() - timedelta(days=CE_MAX_DAYS),
        end=_date.today() + timedelta(days=1),
    )

    agg: dict[tuple[str, str], dict] = {}
    for r in rows:
        if not r["cost"]:
            # Skip BEFORE creating the entry. Densified series are mostly
            # zero rows, so creating the key first printed
            # "None .. None  0 days $0.00" for an all-zero account.
            continue
        key = (r["provider"], r["account_id"])
        a = agg.setdefault(
            key, {"days": set(), "total": 0, "first": None, "last": None}
        )
        a["days"].add(r["usage_date"])
        a["total"] += float(r["cost"])
        a["first"] = min(a["first"] or r["usage_date"], r["usage_date"])
        a["last"] = max(a["last"] or r["usage_date"], r["usage_date"])

    if not agg:
        print("no cost data — run ingest or backfill")
    for (provider, account_id), a in sorted(agg.items()):
        print(
            f"  {provider}/{account_id:<14} "
            f"{a['first']} .. {a['last']}  "
            f"{len(a['days']):>6} days  ${a['total']:,.2f}"
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


