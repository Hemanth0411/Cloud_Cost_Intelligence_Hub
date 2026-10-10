"""Audit helpers.

Two distinct things, easy to confuse:

* audit *columns* (created_by/updated_by/...) live on every table and say
  who last touched a row.
* the audit *log* is append-only and says what changed, with before/after.
  Grant and user changes go here; nothing else needs it.
"""
from __future__ import annotations

import json
from typing import Any

import psycopg

AUDIT_INSERT = """
INSERT INTO audit_log (actor, action, entity_type, entity_id,
                       before, after, request_id)
VALUES (%(actor)s, %(action)s, %(entity_type)s, %(entity_id)s,
        %(before)s, %(after)s, %(request_id)s)
"""


def log(
    cur: psycopg.Cursor,
    *,
    actor: str,
    action: str,
    entity_type: str,
    entity_id: str,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    request_id: str | None = None,
) -> None:
    """Write one audit row, inside the caller's transaction.

    Takes a cursor rather than opening its own connection so the audit
    entry commits or rolls back together with the change it describes --
    an audit log that can disagree with the data is worse than none.
    """
    cur.execute(
        AUDIT_INSERT,
        {
            "actor": actor,
            "action": action,
            "entity_type": entity_type,
            "entity_id": str(entity_id),
            "before": json.dumps(before, default=str) if before else None,
            "after": json.dumps(after, default=str) if after else None,
            "request_id": request_id,
        },
    )
