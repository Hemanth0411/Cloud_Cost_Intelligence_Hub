"""Anomaly findings.

Detection is not built yet; these endpoints read the table so the
frontend can be developed against the real shape.
"""
from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Path, Query, status

from costhub.api.deps import CurrentUser
from costhub.api.envelope import as_of
from costhub.db import connect, fetch_all

router = APIRouter(prefix="/anomalies", tags=["anomalies"])

Status = Literal["new", "acknowledged", "dismissed"]

# Findings are scoped the same way facts are: a user must hold a live
# grant for the account (and service, if the grant is narrowed).
SCOPE = """
EXISTS (
  SELECT 1 FROM access_grants g
  WHERE g.user_id     = %(user_id)s
    AND g.revoked_at  IS NULL
    AND g.deleted_at  IS NULL
    AND g.provider    = a.provider
    AND g.account_id  = a.account_id
    AND (g.service_name IS NULL OR g.service_name = a.service_name)
    AND now() >= g.valid_from
    AND (g.valid_until IS NULL OR now() < g.valid_until)
)
"""


@router.get("", summary="Open anomaly findings")
def list_findings(
    who: CurrentUser,
    status_filter: Annotated[Status, Query(alias="status")] = "new",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict:
    scope = "TRUE" if who.is_superadmin else SCOPE
    rows = fetch_all(
        f"""
        SELECT a.id, a.provider, a.account_id, a.service_name,
               a.detected_for_date, a.method, a.kind,
               a.baseline_value, a.observed_value, a.delta_abs, a.delta_pct,
               a.score, a.status, a.acknowledged_by, a.acknowledged_at
        FROM anomaly_findings a
        WHERE a.status = %(st)s AND ({scope})
        ORDER BY a.detected_for_date DESC, abs(a.delta_abs) DESC
        LIMIT %(lim)s
        """,
        {"user_id": who.user_id, "st": status_filter, "lim": limit},
    )
    return {"data": rows, "as_of": as_of(), "row_count": len(rows)}


@router.post("/{finding_id}/ack", summary="Acknowledge or dismiss a finding")
def acknowledge(
    who: CurrentUser,
    finding_id: Annotated[str, Path()],
    new_status: Annotated[Status, Query(alias="status")] = "acknowledged",
) -> dict:
    scope = "TRUE" if who.is_superadmin else SCOPE
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            f"""
            UPDATE anomaly_findings a
               SET status = %(st)s, acknowledged_by = %(who)s,
                   acknowledged_at = now(), updated_at = now(),
                   updated_by = %(who)s, revision = a.revision + 1
             WHERE a.id = %(id)s AND ({scope})
            RETURNING a.id, a.status
            """,
            {"id": finding_id, "st": new_status, "who": who.email,
             "user_id": who.user_id},
        )
        row = cur.fetchone()
    if row is None:
        # Indistinguishable from 'not found' on purpose: telling an
        # unauthorized caller that a finding exists is a leak.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "finding not found")
    return dict(row)
