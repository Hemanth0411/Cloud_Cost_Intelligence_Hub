"""Run detection across every account and service.

Two decisions worth stating:

**Per account x service, never the aggregate.** A doubling of one small
service vanishes in the account total. Scanning the sum finds nothing and
feels productive.

**One query, grouped in Python.** Fetching each series separately would be
thousands of round-trips. The whole window comes back once.

**Reads through query/scoped**, as the system principal. This module used
to SELECT from fact_cost_daily directly, which quietly falsified the
project's central claim that exactly one module does -- the claim is what
makes the security review cheap, and a second reader with no principal
parameter left a reviewer nowhere to notice one was missing.
`test_invariant.py` now fails the build on any new direct reader.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from costhub.anomaly.mad import MadDetector
from costhub.anomaly.ports import Detector, Finding
from costhub.audit import log as audit_log
from costhub.db import connect
from costhub.query import scoped
from costhub.query.scoped import SYSTEM_EMAIL

log = logging.getLogger(__name__)

Key = tuple[str, str, str]  # provider, account_id, service_name

# Measurements are refreshed on re-run, but status is NOT: once somebody
# has acknowledged or dismissed a finding, a nightly job must not quietly
# mark it new again.
UPSERT = """
INSERT INTO anomaly_findings
  (provider, account_id, service_name, detected_for_date, method, kind,
   baseline_value, observed_value, delta_abs, delta_pct, score,
   created_by, updated_by)
VALUES
  (%(provider)s, %(account_id)s, %(service_name)s, %(d)s, %(method)s, %(kind)s,
   %(baseline)s, %(observed)s, %(delta_abs)s, %(delta_pct)s, %(score)s,
   %(actor)s, %(actor)s)
ON CONFLICT (provider, account_id, service_name, detected_for_date, method)
DO UPDATE SET
  kind           = EXCLUDED.kind,
  baseline_value = EXCLUDED.baseline_value,
  observed_value = EXCLUDED.observed_value,
  delta_abs      = EXCLUDED.delta_abs,
  delta_pct      = EXCLUDED.delta_pct,
  score          = EXCLUDED.score,
  updated_at     = now(),
  updated_by     = EXCLUDED.updated_by,
  revision       = anomaly_findings.revision + 1
RETURNING (xmax = 0) AS inserted
"""




@dataclass
class ScanResult:
    series_scanned: int = 0
    findings: int = 0
    created: int = 0
    updated: int = 0
    by_kind: dict[str, int] | None = None

    def __str__(self) -> str:
        kinds = ", ".join(
            f"{k}={v}" for k, v in sorted((self.by_kind or {}).items())
        )
        return (
            f"{self.series_scanned} series scanned, {self.findings} findings "
            f"({self.created} new, {self.updated} refreshed)"
            + (f" -- {kinds}" if kinds else "")
        )


def _load(start: date, end: date) -> dict[Key, list[tuple[date, Decimal]]]:
    """Every daily series in the window, via the scoped reader.

    Detection has to see every account by design -- an anomaly in an
    account nobody has been granted is still an anomaly -- so it reads as
    the system principal. That is a named, greppable function rather than
    a bare role literal, and `scan()` records one audit row per run.
    """
    rows = scoped.all_series(scoped.system_principal(), start=start, end=end)
    grouped: dict[Key, list[tuple[date, Decimal]]] = {}
    for r in rows:
        key: Key = (r["provider"], r["account_id"], r["service_name"])
        grouped.setdefault(key, []).append((r["usage_date"], r["cost"]))
    return grouped


def scan(
    *,
    detector: Detector | None = None,
    lookback_days: int = 120,
    actor: str = SYSTEM_EMAIL,
) -> ScanResult:
    """Detect across all series and persist the findings."""
    det = detector or MadDetector()
    end = date.today()
    start = end - timedelta(days=lookback_days)

    grouped = _load(start, end)
    result = ScanResult(by_kind={})

    with connect() as conn, conn.cursor() as cur:
        for (provider, account_id, service_name), points in grouped.items():
            result.series_scanned += 1
            for f in det.detect(points):
                inserted = _persist(
                    cur, provider, account_id, service_name, f, actor
                )
                result.findings += 1
                result.created += int(inserted)
                result.updated += int(not inserted)
                assert result.by_kind is not None
                result.by_kind[f.kind] = result.by_kind.get(f.kind, 0) + 1

        # One audit entry per run, not per query: detection reads every
        # account by design, and a row per read would bury the log.
        audit_log(
            cur,
            actor=actor,
            action="anomaly.scan",
            entity_type="anomaly_scan",
            entity_id=f"{start}..{end}",
            after={
                "series_scanned": result.series_scanned,
                "findings": result.findings,
                "by_kind": result.by_kind,
                "method": getattr(det, "name", "unknown"),
            },
        )

    log.info("anomaly scan: %s", result)
    return result


def _persist(
    cur,
    provider: str,
    account_id: str,
    service_name: str,
    f: Finding,
    actor: str,
) -> bool:
    cur.execute(
        UPSERT,
        {
            "provider": provider,
            "account_id": account_id,
            "service_name": service_name,
            "d": f.detected_for_date,
            "method": f.method,
            "kind": f.kind,
            "baseline": f.baseline_value,
            "observed": f.observed_value,
            "delta_abs": f.delta_abs,
            "delta_pct": f.delta_pct,
            "score": f.score,
            "actor": actor,
        },
    )
    row = cur.fetchone()
    return bool(row and row["inserted"])
