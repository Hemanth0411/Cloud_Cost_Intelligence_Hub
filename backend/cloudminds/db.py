"""Connection handling. Thin on purpose -- no ORM.

The grant predicate in query/scoped.py is the security boundary of this
application; it stays as readable SQL so it can be reviewed and tested
directly rather than inferred from an ORM's generated output.
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row

from cloudminds.config import settings


@contextmanager
def connect() -> Iterator[psycopg.Connection]:
    """A transactional connection. Commits on success, rolls back on error."""
    conn = psycopg.connect(settings().database_url, row_factory=dict_row)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def fetch_all(sql: str, params: dict[str, Any] | None = None) -> list[dict]:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, params or {})
        return cur.fetchall()


def fetch_one(sql: str, params: dict[str, Any] | None = None) -> dict | None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, params or {})
        return cur.fetchone()


def execute(sql: str, params: dict[str, Any] | None = None) -> int:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, params or {})
        return cur.rowcount
