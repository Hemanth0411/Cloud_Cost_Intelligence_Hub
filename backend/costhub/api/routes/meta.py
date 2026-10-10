"""Filter options -- scoped, so a dropdown cannot leak what a user may
not see. This is what makes the access control visible in the UI rather
than merely asserted.
"""
from __future__ import annotations

from fastapi import APIRouter

from costhub.api.deps import CurrentUser
from costhub.api.envelope import as_of
from costhub.query import scoped

router = APIRouter(prefix="/meta", tags=["meta"])


@router.get("/accounts", summary="Accounts this user may see")
def accounts(who: CurrentUser) -> dict:
    return {"data": scoped.visible_accounts(who), "as_of": as_of()}


@router.get("/services", summary="Services this user may see in an account")
def services(who: CurrentUser, provider: str, account_id: str) -> dict:
    return {
        "data": scoped.visible_services(who, provider, account_id),
        "as_of": as_of(),
    }


@router.get("/me", summary="The caller, as the server sees them")
def me(who: CurrentUser) -> dict:
    return {
        "email": who.email,
        "role": who.role,
        "is_superadmin": who.is_superadmin,
    }
