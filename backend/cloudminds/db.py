"""Connection handling. Thin on purpose -- no ORM.

The grant predicate in query/scoped.py is the security boundary of this
application; it stays as readable SQL so it can be reviewed and tested
directly rather than inferred from an ORM's generated output.

Connections come from a module-level pool. That matters in two places:
a warm Lambda container reuses it across invocations, and the test suite
would otherwise pay a fresh TLS handshake (~1.8s against Neon) for every
single statement.
"""
from __future__ import annotations

import atexit
import threading
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from cloudminds.config import settings

_pool: ConnectionPool | None = None
_lock = threading.Lock()


def pool() -> ConnectionPool:
    """The process-wide pool, opened on first use."""
    global _pool
    if _pool is None:
        with _lock:
            if _pool is None:
                _pool = ConnectionPool(
                    conninfo=settings().database_url,
                    min_size=1,
                    max_size=5,
                    kwargs={"row_factory": dict_row},
                    open=True,
                    timeout=30,
                )
    return _pool


def reset_pool() -> None:
    """Close the pool so the next call rebuilds it.

    Needed when DATABASE_URL changes at runtime -- which only happens in
    tests, where each session is pinned to its own schema.
    """
    global _pool
    with _lock:
        if _pool is not None:
            _pool.close()
            _pool = None


atexit.register(reset_pool)


@contextmanager
def connect() -> Iterator[psycopg.Connection]:
    """A pooled, transactional connection.

    Commits on success, rolls back on error, and returns the connection to
    the pool either way.
    """
    with pool().connection() as conn:
        try:
            yield conn
        except Exception:
            conn.rollback()
            raise


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
