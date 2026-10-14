"""Superadmin: remove a user, or change their role.

Split out of routes/admin.py, which was 164 lines and holds the reads,
the invite and the grants. Same split connection_edits.py made from
connections.py, for the same reason: these two routes are the only ones
that can take someone's access away, they share a set of refusals, and
they have their own store module (`rbac/users.py`).

Mounted by routes/admin.py, so the paths keep the `/admin` prefix and
main.py does not need to know this file exists.

THE REFUSALS ANSWER 409, NOT 403. A 403 from these routes would read as
"you are not allowed to manage users", which is false and would send a
superadmin to look at their own permissions. The request was permitted;
it conflicts with the state of the system -- you are the target, or
there is nobody left to hand over to. The `rbac.users` docstring has the
reasoning for the rules themselves.
"""
from __future__ import annotations

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from costhub.api.deps import SuperAdmin
from costhub.rbac import users

router = APIRouter()


class RoleIn(BaseModel):
    role: Literal["superadmin", "user"]


# `user_id` is typed UUID so FastAPI answers 422 for a malformed id.
# Without it the string reached Postgres and came back as a bare 500 from
# InvalidTextRepresentation, which says nothing a caller can act on.


def _refusal(exc: Exception) -> HTTPException:
    """One mapping, so both routes refuse the same way."""
    if isinstance(exc, users.NoSuchUser):
        return HTTPException(status.HTTP_404_NOT_FOUND, "no such user")
    return HTTPException(status.HTTP_409_CONFLICT, str(exc))


@router.delete("/users/{user_id}", summary="Remove a user")
def remove_user(who: SuperAdmin, user_id: UUID) -> dict:
    """Soft delete, and disable their Cognito login.

    `login_disabled` is reported rather than assumed, and that is the
    point of returning it: the database stamp is what denies access, and
    it has already committed by the time the pool call is made. A false
    here means they are out of the product but their Cognito user is
    still enabled -- harmless for access (every endpoint refuses them)
    and worth fixing, so it must not be hidden behind a 200.

    `grants_kept` is true and says so for the same reason the connection
    delete does: "remove" reads as "erase", and their grants survive so
    that re-inviting them restores what they could see.
    """
    try:
        return users.remove_user(
            actor=who.email, actor_role=who.role, user_id=str(user_id)
        )
    except (users.NoSuchUser, users.RefusedSelf, users.LastSuperadmin) as exc:
        raise _refusal(exc) from exc


@router.post("/users/{user_id}/role", summary="Grant or revoke superadmin")
def set_user_role(who: SuperAdmin, user_id: UUID, body: RoleIn) -> dict:
    """Change a role. `changed: false` means it already was that role.

    Promotion is unrestricted; demotion refuses self and the last
    superadmin. See `rbac/users.set_role`.
    """
    try:
        return users.set_role(
            actor=who.email,
            actor_role=who.role,
            user_id=str(user_id),
            role=body.role,
        )
    except (users.NoSuchUser, users.RefusedSelf, users.LastSuperadmin) as exc:
        raise _refusal(exc) from exc
