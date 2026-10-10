"""Alert rules and the in-app feed.

Rule evaluation is not built yet; these endpoints manage rules and read
events so the frontend can be developed against the real shape.
"""
from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from costhub.api.deps import CurrentUser
from costhub.api.envelope import as_of
from costhub.db import connect, fetch_all

router = APIRouter(prefix="/alerts", tags=["alerts"])

RuleType = Literal["threshold", "forecast", "digest", "anomaly"]
Comparator = Literal["gt", "gte", "lt", "lte"]
Frequency = Literal["immediate", "daily", "weekly", "monthly"]


class RuleIn(BaseModel):
    name: str
    type: RuleType = "threshold"
    scope_provider: str | None = Field(None, description="Null = all providers")
    scope_account: str | None = Field(None, description="Null = all accounts")
    scope_service: str | None = Field(None, description="Null = all services")
    metric: str = "effective_cost"
    comparator: Comparator | None = "gt"
    threshold_value: float | None = None
    window_days: int = Field(1, ge=1, le=365)
    frequency: Frequency = "daily"
    channels: list[str] = Field(default_factory=lambda: ["inapp"])
    enabled: bool = True


@router.get("/rules", summary="Your alert rules")
def list_rules(who: CurrentUser) -> dict:
    rows = fetch_all(
        """
        SELECT id, name, type, scope_provider, scope_account, scope_service,
               metric, comparator, threshold_value, window_days, frequency,
               channels, enabled, created_at
        FROM alert_rules
        WHERE deleted_at IS NULL
          AND (%(admin)s OR owner_user_id = %(uid)s)
        ORDER BY created_at DESC
        """,
        {"uid": who.user_id, "admin": who.is_superadmin},
    )
    return {"data": rows, "row_count": len(rows)}


@router.post("/rules", status_code=201, summary="Create an alert rule")
def create_rule(who: CurrentUser, body: RuleIn) -> dict:
    """A rule may be created for any scope, but delivery re-checks grants
    at send time -- a rule can outlive the grant that justified it."""
    import json

    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO alert_rules
              (name, owner_user_id, scope_provider, scope_account, scope_service,
               type, metric, comparator, threshold_value, window_days,
               frequency, channels, enabled, created_by, updated_by)
            VALUES
              (%(name)s, %(uid)s, %(sp)s, %(sa)s, %(ss)s,
               %(ty)s, %(me)s, %(cm)s, %(th)s, %(wd)s,
               %(fr)s, %(ch)s, %(en)s, %(actor)s, %(actor)s)
            RETURNING id
            """,
            {
                "name": body.name, "uid": who.user_id,
                "sp": body.scope_provider, "sa": body.scope_account,
                "ss": body.scope_service, "ty": body.type, "me": body.metric,
                "cm": body.comparator, "th": body.threshold_value,
                "wd": body.window_days, "fr": body.frequency,
                "ch": json.dumps(body.channels), "en": body.enabled,
                "actor": who.email,
            },
        )
        row = cur.fetchone()
    assert row is not None
    return {"id": str(row["id"])}


@router.delete("/rules/{rule_id}", summary="Delete an alert rule")
def delete_rule(who: CurrentUser, rule_id: str) -> dict:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE alert_rules
               SET deleted_at = now(), deleted_by = %(actor)s,
                   updated_at = now(), updated_by = %(actor)s,
                   revision = revision + 1
             WHERE id = %(id)s AND deleted_at IS NULL
               AND (%(admin)s OR owner_user_id = %(uid)s)
            RETURNING id
            """,
            {"id": rule_id, "actor": who.email, "uid": who.user_id,
             "admin": who.is_superadmin},
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "rule not found")
    return {"id": rule_id, "deleted": True}


@router.get("/feed", summary="In-app alert feed")
def feed(
    who: CurrentUser,
    unread_only: bool = False,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict:
    rows = fetch_all(
        """
        SELECT e.id, e.rule_id, r.name AS rule_name, r.type,
               e.fired_at, e.observed_value, e.expected_value,
               e.payload, e.status, e.delivered_at, e.delivery_error
        FROM alert_events e
        JOIN alert_rules r ON r.id = e.rule_id
        WHERE (%(admin)s OR r.owner_user_id = %(uid)s)
          AND (NOT %(unread)s OR e.status = 'new')
        ORDER BY e.fired_at DESC LIMIT %(lim)s
        """,
        {"uid": who.user_id, "admin": who.is_superadmin,
         "unread": unread_only, "lim": limit},
    )
    return {"data": rows, "as_of": as_of(), "row_count": len(rows)}


@router.post("/feed/{event_id}/read", summary="Mark a feed item read")
def mark_read(who: CurrentUser, event_id: str) -> dict:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE alert_events e
               SET status = 'read', updated_at = now(), updated_by = %(actor)s,
                   revision = e.revision + 1
             WHERE e.id = %(id)s
               AND EXISTS (SELECT 1 FROM alert_rules r
                           WHERE r.id = e.rule_id
                             AND (%(admin)s OR r.owner_user_id = %(uid)s))
            RETURNING e.id
            """,
            {"id": event_id, "actor": who.email, "uid": who.user_id,
             "admin": who.is_superadmin},
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "event not found")
    return {"id": event_id, "status": "read"}
