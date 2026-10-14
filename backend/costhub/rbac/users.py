"""Remove a user, and change a user's role.

Split from `rbac/admin.py`, which invites users and writes grants, along
the boundary `connections/edits.py` already uses: that module registers a
thing, this one changes a thing that already exists, and every function
here takes a `user_id` rather than an email.

THE REFUSALS ARE THE POINT OF THIS MODULE. Both operations can end every
administrator's access to the product, and neither is recoverable from
the UI once it has happened -- the only way back is `bootstrap-admin` on
the one laptop that holds the Terraform state and the deployed
DATABASE_URL. So two rules, enforced here rather than in the route:

  * Nobody removes or demotes THEMSELVES. A misclick on your own row
    would otherwise revoke your own authority mid-task, and the screen
    that could undo it is the screen you just lost.
  * The number of live superadmins can never reach zero.

BOTH ARE CHECKED UNDER A LOCK, in the same transaction as the write, and
that is not belt-and-braces. The dangerous case is two administrators
acting at the same moment: each request reads "there are 2 superadmins",
each decides its own removal is therefore safe, and both commit. Locking
every live superadmin row first (`LOCK_SUPERADMINS`) serialises exactly
that pair, so the second request re-counts after the first has committed
and is refused.

Both functions lock the superadmins BEFORE the target, always in that
order, so two concurrent requests cannot deadlock by taking the same two
locks the other way round.
"""
from __future__ import annotations

from costhub.audit import log
from costhub.db import connect
from costhub.rbac import pool
from costhub.rbac.admin import NotPermitted

ROLES = ("superadmin", "user")


class NoSuchUser(Exception):
    """No live user with that id. The caller's list is stale."""


class RefusedSelf(Exception):
    """You are the target, and that is the one thing this will not do."""


class LastSuperadmin(Exception):
    """This would leave the product with no administrator."""


# Every live superadmin, locked. Read for its COUNT; taken for its lock.
LOCK_SUPERADMINS = """
SELECT id FROM users
 WHERE role = 'superadmin' AND deleted_at IS NULL
 FOR UPDATE
"""

TARGET = """
SELECT id, email, display_name, role, status
  FROM users
 WHERE id = %(id)s AND deleted_at IS NULL
 FOR UPDATE
"""

REMOVE = """
UPDATE users
   SET deleted_at = now(), deleted_by = %(actor)s,
       status = 'disabled',
       updated_at = now(), updated_by = %(actor)s,
       revision = revision + 1
 WHERE id = %(id)s AND deleted_at IS NULL
"""

SET_ROLE = """
UPDATE users
   SET role = %(role)s, updated_at = now(), updated_by = %(actor)s,
       revision = revision + 1
 WHERE id = %(id)s AND deleted_at IS NULL
"""


def _require_superadmin(actor_role: str) -> None:
    # The same two lines as `rbac/admin._require_superadmin`. The real
    # gate is the route's `SuperAdmin` dependency; this is the defence in
    # depth that makes the module safe to call from the CLI too.
    if actor_role != "superadmin":
        raise NotPermitted("superadmin required")


def _disable_login(email: str) -> str:
    """Disable the pool user, reporting failure rather than raising.

    A Cognito outage must not block removing someone from the product.
    The database stamp is what actually denies access -- every endpoint
    refuses a row with `deleted_at` set -- so the removal is allowed to
    succeed with the login half reported as failed, and a retry is
    harmless because `disable_user` is idempotent.

    `Exception`, not `PoolError`, and the breadth is the point. Catching
    only PoolError made the paragraph above FALSE for the failures most
    likely to happen: `disable_user` converts a ClientError, but
    botocore raises NoCredentialsError and NoRegionError before any
    request is sent, and those would have propagated out of the open
    transaction and rolled the removal back -- a security operation
    refused because a side system could not be reached. The removal is
    the part that must land; the detail string carries whatever went
    wrong so it is reported rather than lost.
    """
    try:
        return pool.disable_user(email)
    except Exception as exc:  # noqa: BLE001 -- see the docstring
        return f"failed: {type(exc).__name__}: {exc}"


def remove_user(*, actor: str, actor_role: str, user_id: str) -> dict:
    """Soft-delete a user and stop their login. Returns what happened.

    SOFT, like every other delete here. `deleted_at` is stamped and the
    row stays, because `audit_log` entries name this user and a trail
    pointing at a row that no longer exists is not a trail. `status` goes
    to 'disabled' as well so the row reads correctly anywhere that shows
    status without filtering on `deleted_at`.

    THE GRANTS ARE LEFT ALONE, and they are inert either way: a grant is
    only ever consulted through a `Principal`, and `deps._load_user`
    cannot build one for a removed user. Revoking them too would stamp
    `revoked_by` on history that nobody revoked, and would lose the
    answer to "what could this person see before they left" -- which is
    the question an audit trail exists for. Re-inviting them restores the
    row, and their old grants with it; that is worth knowing before
    treating removal as "they have nothing".

    The Cognito call happens inside the transaction but cannot roll it
    back (see `_disable_login`), so the single audit row records the
    login outcome alongside the removal and there is no second write
    that could disagree with the first.
    """
    _require_superadmin(actor_role)
    actor_email = actor.strip().lower()

    with connect() as conn, conn.cursor() as cur:
        cur.execute(LOCK_SUPERADMINS)
        superadmins = len(cur.fetchall())

        cur.execute(TARGET, {"id": user_id})
        target = cur.fetchone()
        if target is None:
            raise NoSuchUser(user_id)

        if target["email"] == actor_email:
            raise RefusedSelf(
                "You cannot remove your own account. Ask another superadmin."
            )
        if target["role"] == "superadmin" and superadmins <= 1:
            raise LastSuperadmin(
                f"{target['email']} is the only superadmin left, and removing "
                "them would leave nobody able to manage users or accounts. "
                "Promote someone else first."
            )

        cur.execute(REMOVE, {"id": user_id, "actor": actor})
        login = _disable_login(target["email"])

        log(
            cur,
            actor=actor,
            action="user.remove",
            entity_type="user",
            entity_id=user_id,
            before={
                "email": target["email"],
                "role": target["role"],
                "status": target["status"],
            },
            after={"deleted": True, "grants_kept": True, "login": login},
        )

    return {
        "id": str(user_id),
        "email": target["email"],
        "deleted": True,
        "grants_kept": True,
        # "disabled" is the only outcome that means their login is gone.
        # "skipped" is local development with no pool, "absent" is a row
        # that never had one, and "failed: ..." is a Cognito error the
        # operator has to see rather than a silent partial success.
        "login_disabled": login == "disabled",
        "login_detail": login,
    }


def set_role(*, actor: str, actor_role: str, user_id: str, role: str) -> dict:
    """Promote to superadmin, or demote back to user.

    Until this existed the only way to create a superadmin was
    `./do.sh cli dev bootstrap-admin --email ...`, which needs the
    laptop, the profile and the deployed DATABASE_URL -- so in practice
    the role was unchangeable.

    The two refusals apply to DEMOTION only, which is the direction that
    can take authority away. Promoting is always allowed: it cannot
    reduce the superadmin count, and a superadmin promoting someone is
    the whole mechanism.

    `status` is deliberately untouched. `bootstrap-admin` sets
    'active' with the role because it is bootstrapping a first login,
    but here an invited-and-not-yet-signed-in user who is promoted
    should stay 'invited' -- the role says what they may do, the status
    says whether they have arrived, and conflating them would report
    someone as active who has never logged in.
    """
    _require_superadmin(actor_role)
    if role not in ROLES:
        raise ValueError(f"role must be one of {ROLES}")
    actor_email = actor.strip().lower()

    with connect() as conn, conn.cursor() as cur:
        cur.execute(LOCK_SUPERADMINS)
        superadmins = len(cur.fetchall())

        cur.execute(TARGET, {"id": user_id})
        target = cur.fetchone()
        if target is None:
            raise NoSuchUser(user_id)

        if target["role"] == role:
            # Idempotent, and NOT audited. An audit row saying a role
            # changed from 'user' to 'user' is noise in the one log that
            # has to stay readable.
            return {
                "id": str(user_id),
                "email": target["email"],
                "role": role,
                "changed": False,
            }

        if role != "superadmin":
            if target["email"] == actor_email:
                raise RefusedSelf(
                    "You cannot remove your own superadmin role. Ask another "
                    "superadmin."
                )
            if superadmins <= 1:
                raise LastSuperadmin(
                    f"{target['email']} is the only superadmin left. Promote "
                    "someone else before demoting them."
                )

        cur.execute(SET_ROLE, {"id": user_id, "role": role, "actor": actor})
        log(
            cur,
            actor=actor,
            action="user.role",
            entity_type="user",
            entity_id=user_id,
            before={"email": target["email"], "role": target["role"]},
            after={"role": role},
        )

    return {
        "id": str(user_id),
        "email": target["email"],
        "role": role,
        "changed": True,
    }
