"""The invariant, enforced mechanically.

The project's central claim is that exactly one module reads
`fact_cost_daily`, and that module always applies the grant predicate.
That claim is what makes the security review cheap -- a reviewer only has
to read `scoped.py`.

It had already silently become false: `anomaly/runner.py` and `cli.py`
both grew direct reads. Asserting it in prose did not hold; asserting it
in a test does.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
PACKAGE = BACKEND / "costhub"
FACT_TABLE = "fact_cost_daily"

# scoped.py is the sanctioned reader. ingest/runner.py WRITES (upsert),
# which is a different concern: the grant predicate governs who may READ
# whose spend, not who may record it.
READERS_ALLOWED = {
    Path("query/scoped.py"),
    Path("ingest/runner.py"),
}

SELECT_RE = re.compile(r"(?is)\bselect\b.*?\bfrom\s+" + FACT_TABLE)


def _sql_literals(path: Path) -> list[str]:
    """String literals in a module, EXCLUDING docstrings and comments.

    Matching raw source text gave false positives the moment a docstring
    explained the rule it was documenting -- the comment in
    anomaly/runner.py saying it "used to SELECT from fact_cost_daily"
    tripped the check it exists to support. Comments are dropped by the
    parser; docstrings are identified and skipped explicitly.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))

    doc_nodes: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(
            node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
        ):
            body = getattr(node, "body", [])
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                doc_nodes.add(id(body[0].value))

    return [
        n.value
        for n in ast.walk(tree)
        if isinstance(n, ast.Constant)
        and isinstance(n.value, str)
        and id(n) not in doc_nodes
    ]


def _modules() -> list[Path]:
    return sorted(p for p in PACKAGE.rglob("*.py") if "__pycache__" not in p.parts)


def test_only_scoped_reads_the_fact_table():
    offenders = []
    for path in _modules():
        rel = path.relative_to(PACKAGE)
        if rel in READERS_ALLOWED:
            continue
        if any(SELECT_RE.search(s) for s in _sql_literals(path)):
            offenders.append(rel.as_posix())

    assert not offenders, (
        "These modules SELECT from fact_cost_daily directly, which breaks the "
        "single-enforcement-point invariant (NFR-1). Read through "
        "query/scoped instead -- use scoped.system_principal() for a "
        f"background job that must see every account: {offenders}"
    )


def test_the_check_would_actually_catch_a_violation():
    """Guard the guard: a detector that cannot fail proves nothing."""
    assert SELECT_RE.search("SELECT provider FROM fact_cost_daily WHERE x")
    assert SELECT_RE.search("select sum(cost)\n  from fact_cost_daily f")
    assert not SELECT_RE.search("INSERT INTO fact_cost_daily (provider) VALUES (1)")
    assert not SELECT_RE.search("SELECT 1 FROM anomaly_findings")


# `_where(principal, f)` or `_where(principal, f, <kwargs>)`.
#
# This was the exact literal "_where(principal, f)", which counted zero
# for a call that passed anything else -- so adding the `audit_bypass`
# keyword to one call site made the test report a MISSING grant
# predicate on a query that still had one. A guard that fires on an
# argument list is reporting on syntax, not on the invariant.
#
# The `[,)]` is deliberate and keeps this as strict as the literal was:
# it still requires the call to be `_where` applied to exactly
# `principal, f`, so `_where(principal, other)` or a renamed first
# argument does not count.
WHERE_CALL_RE = re.compile(r"_where\(principal, f[,)]")


def test_scoped_itself_still_applies_the_predicate():
    """Every fact query inside scoped.py must go through _where."""
    src = (PACKAGE / "query" / "scoped.py").read_text(encoding="utf-8")
    fact_queries = src.count(f"FROM {FACT_TABLE} f")
    where_calls = len(WHERE_CALL_RE.findall(src))
    assert fact_queries > 0, "expected scoped.py to query the fact table"
    assert where_calls >= fact_queries, (
        f"{fact_queries} fact queries but only {where_calls} _where() calls -- "
        "a query may be missing the grant predicate"
    )


def test_the_where_call_check_would_catch_a_violation():
    """Guard the guard, for the matcher above."""
    assert WHERE_CALL_RE.search("where, params = _where(principal, f)")
    assert WHERE_CALL_RE.search("_where(principal, f, audit_bypass=False)")
    # A query that skipped the predicate entirely must NOT count.
    assert not WHERE_CALL_RE.search("where = build_clauses(principal, f)")
    # Nor must a call on something other than the filters in hand.
    assert not WHERE_CALL_RE.search("_where(principal, other)")
    assert not WHERE_CALL_RE.search("_where(someone, f)")


@pytest.mark.parametrize("name", ["GRANT_PREDICATE", "system_principal", "all_series"])
def test_security_surface_is_still_named_as_expected(name):
    """These names are referenced by the docs and by the drift guard."""
    src = (PACKAGE / "query" / "scoped.py").read_text(encoding="utf-8")
    assert name in src


# ------------------------------------------- fabricated superadmins

def _superadmin_principals(path: Path) -> list[int]:
    """Lines constructing a Principal with role="superadmin".

    The grant predicate is replaced wholesale for a superadmin, so a
    module that builds its own superadmin Principal has written an
    access-control bypass -- whatever it is actually for. There is one
    legitimate need (background jobs must see every account) and
    `scoped.system_principal()` is it: named, greppable, and excluded
    from the bypass audit for that reason.

    This looks for the CONSTRUCTOR specifically, not the string. Other
    modules legitimately mention the role -- cli.py passes
    `actor_role="superadmin"` to assert the operator's own authority,
    and comparisons against the role are how permission checks are
    written.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    hits = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = getattr(func, "id", None) or getattr(func, "attr", None)
        if name != "Principal":
            continue
        for kw in node.keywords:
            if (
                kw.arg == "role"
                and isinstance(kw.value, ast.Constant)
                and kw.value.value == "superadmin"
            ):
                hits.append(node.lineno)
    return hits


def test_only_scoped_can_mint_a_superadmin():
    offenders = []
    for path in _modules():
        rel = path.relative_to(PACKAGE)
        if rel == Path("query/scoped.py"):
            continue
        for lineno in _superadmin_principals(path):
            offenders.append(f"{rel.as_posix()}:{lineno}")

    assert not offenders, (
        "These construct a superadmin Principal directly, which replaces the "
        "grant predicate with TRUE and bypasses access control. Use "
        "scoped.system_principal() for a background job that must see every "
        f"account: {offenders}"
    )


def test_the_superadmin_check_would_catch_a_violation():
    """Guard the guard, again."""
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        bad = Path(d) / "bad.py"
        bad.write_text(
            'p = Principal(user_id="x", email="e", role="superadmin")\n',
            encoding="utf-8",
        )
        assert _superadmin_principals(bad) == [1]

        # The forms that must NOT trip it: asserting the operator's own
        # authority, and comparing against the role.
        ok = Path(d) / "ok.py"
        ok.write_text(
            'grant(actor="me", actor_role="superadmin")\n'
            'if who.role == "superadmin":\n'
            "    pass\n",
            encoding="utf-8",
        )
        assert _superadmin_principals(ok) == []


# ------------------------------------------------- the size convention

MAX_LINES = 300

# scoped.py is deliberately over the limit. The project's central claim
# is that exactly ONE module reads the fact table and applies the grant
# predicate; splitting it to satisfy a line count would trade a security
# property for a style one, and would defeat
# test_only_scoped_reads_the_fact_table above. Named here so the
# exception is explicit and reviewed rather than silently tolerated.
SIZE_EXEMPT = {Path("query/scoped.py")}


def test_source_files_respect_the_line_limit():
    """NFR-18, enforced rather than asserted in prose.

    It had already drifted: azure_cm.py reached 372 lines and cli.py 330
    before anyone noticed, because the convention lived only in a doc.
    """
    oversized = []
    for path in _modules():
        rel = path.relative_to(PACKAGE)
        if rel in SIZE_EXEMPT:
            continue
        n = len(path.read_text(encoding="utf-8").splitlines())
        if n > MAX_LINES:
            oversized.append(f"{rel.as_posix()} ({n})")

    assert not oversized, (
        f"Files over {MAX_LINES} lines (NFR-18). Split them, or add a "
        f"reasoned entry to SIZE_EXEMPT: {oversized}"
    )


def test_the_exemption_is_still_needed():
    """Do not let an exemption outlive its reason."""
    for rel in SIZE_EXEMPT:
        n = len((PACKAGE / rel).read_text(encoding="utf-8").splitlines())
        assert n > MAX_LINES, (
            f"{rel.as_posix()} is now {n} lines and no longer needs its "
            "SIZE_EXEMPT entry -- remove it"
        )
