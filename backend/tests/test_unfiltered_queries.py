"""The no-filter path, which is the one the UI always takes.

Both of these raised a 500 in production while 140 tests passed:

    psycopg.errors.AmbiguousParameter:
      could not determine data type of parameter $1
    LINE 4:  WHERE ($1 IS NULL OR entity_type = $1)

Postgres has nothing to infer a type from when an untyped parameter is
compared with `IS NULL`, so the query is rejected before it runs. Passing
a value types the parameter and the query is fine -- which is why every
existing test passed: they all supplied a filter.

The frontend supplies none. So the only call shape the product actually
makes was the one shape nothing covered.
"""
from __future__ import annotations

from costhub.rbac import admin as rbac


def test_list_grants_with_no_email_filter(make_user, make_grant, exec_sql):
    """`GET /admin/grants` with no query string -- what the Users page does."""
    user = make_user("nofilter@chryselys.com")
    make_grant(user, "111122223333")

    rows = rbac.list_grants()

    assert isinstance(rows, list)
    assert any(r["email"] == "nofilter@chryselys.com" for r in rows)


def test_list_grants_still_filters_when_given_an_email(make_user, make_grant, exec_sql):
    """The cast must not have turned the filter into a no-op."""
    a = make_user("a@chryselys.com")
    b = make_user("b@chryselys.com")
    make_grant(a, "111122223333")
    make_grant(b, "444455556666")

    rows = rbac.list_grants(user_email="a@chryselys.com")

    assert rows, "expected at least one grant for a@chryselys.com"
    assert {r["email"] for r in rows} == {"a@chryselys.com"}


def test_audit_query_with_no_entity_type(exec_sql):
    """`GET /admin/audit?limit=200` -- what the Audit page does."""
    from costhub.db import fetch_all

    rows = fetch_all(
        """
        SELECT id, actor, action, entity_type, entity_id, before, after, at
        FROM audit_log
        WHERE (%(et)s::text IS NULL OR entity_type = %(et)s)
        ORDER BY at DESC LIMIT %(lim)s
        """,
        {"et": None, "lim": 200},
    )
    assert isinstance(rows, list)


def test_audit_query_still_filters_by_entity_type(make_user, exec_sql):
    """Guard the guard: the cast must not have broken the filter."""
    from costhub.db import fetch_all

    make_user("audited@chryselys.com")  # writes a user.invite audit row

    matching = fetch_all(
        """
        SELECT entity_type FROM audit_log
        WHERE (%(et)s::text IS NULL OR entity_type = %(et)s)
        """,
        {"et": "user"},
    )
    assert all(r["entity_type"] == "user" for r in matching)

    none_match = fetch_all(
        """
        SELECT entity_type FROM audit_log
        WHERE (%(et)s::text IS NULL OR entity_type = %(et)s)
        """,
        {"et": "does-not-exist"},
    )
    assert none_match == []
