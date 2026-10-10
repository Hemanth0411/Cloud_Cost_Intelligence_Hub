"""Answering "may this user see this scope, right now?"

Used by alert delivery (FR-34): a rule can outlive the grant that
justified it. Somebody is granted an account for two weeks, builds an
alert, the grant expires -- and without this check the rule keeps emailing
them about an account they can no longer open.

**This predicate must stay identical to query/scoped.GRANT_PREDICATE.**
It is expressed separately because that one filters fact rows by join,
while this one answers a yes/no about a named scope. The drift risk is
real, so `test_resolve_agrees_with_scoped` asserts the two give the same
answers rather than trusting that they do.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from costhub.db import fetch_all, fetch_one

# Mirrors scoped.GRANT_PREDICATE: live window, not revoked, not deleted,
# NULL service_name means every service in the account.
CAN_SEE = """
SELECT EXISTS (
  SELECT 1
  FROM access_grants g
  WHERE g.user_id      = %(user_id)s
    AND g.revoked_at  IS NULL
    AND g.deleted_at  IS NULL
    AND g.provider     = %(provider)s::text
    AND g.account_id   = %(account_id)s::text
    -- Asking with service_name NULL means "the account as a whole", and
    -- ANY live grant on it answers yes -- a user granted one service can
    -- legitimately own an account-wide rule, because query/scoped narrows
    -- the data to what they may see. Requiring an all-services grant here
    -- would kill that rule while the same user can still read the data.
    AND (%(service_name)s::text IS NULL
         OR g.service_name IS NULL
         OR g.service_name = %(service_name)s::text)
    AND now() >= g.valid_from
    AND (g.valid_until IS NULL OR now() < g.valid_until)
) AS allowed
"""

LIVE_GRANTS = """
SELECT g.id, g.provider, g.account_id, g.service_name,
       g.valid_from, g.valid_until
FROM access_grants g
WHERE g.user_id      = %(user_id)s
  AND g.revoked_at  IS NULL
  AND g.deleted_at  IS NULL
  AND now() >= g.valid_from
  AND (g.valid_until IS NULL OR now() < g.valid_until)
ORDER BY g.provider, g.account_id, g.service_name NULLS FIRST
"""


@dataclass(frozen=True)
class Grant:
    id: str
    provider: str
    account_id: str
    service_name: str | None
    valid_from: datetime
    valid_until: datetime | None

    @property
    def all_services(self) -> bool:
        return self.service_name is None


def effective_grants(user_id: str) -> list[Grant]:
    """Every grant live for this user at this instant."""
    return [
        Grant(
            id=str(r["id"]),
            provider=r["provider"],
            account_id=r["account_id"],
            service_name=r["service_name"],
            valid_from=r["valid_from"],
            valid_until=r["valid_until"],
        )
        for r in fetch_all(LIVE_GRANTS, {"user_id": user_id})
    ]


def can_see(
    user_id: str,
    *,
    provider: str | None,
    account_id: str | None,
    service_name: str | None = None,
    is_superadmin: bool = False,
) -> bool:
    """May this user see this scope now?

    An unscoped rule (provider or account null) means "whatever I can
    see", so it is permitted as long as the user holds *any* live grant.
    The data itself is still filtered by query/scoped, so an unscoped
    rule cannot widen what its owner sees.
    """
    if is_superadmin:
        return True

    if provider is None or account_id is None:
        return bool(effective_grants(user_id))

    row = fetch_one(
        CAN_SEE,
        {
            "user_id": user_id,
            "provider": provider,
            "account_id": account_id,
            "service_name": service_name,
        },
    )
    return bool(row and row["allowed"])


def describe(
    provider: str | None, account_id: str | None, service_name: str | None
) -> str:
    """A human-readable scope, for alert bodies and delivery errors."""
    if account_id is None:
        return "all accounts"
    where = f"{provider or 'aws'}/{account_id}"
    return f"{where}/{service_name}" if service_name else f"{where} (all services)"
