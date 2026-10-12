"""Principal resolution -- the only place a Principal is constructed.

Two modes:

  cognito  verify the JWT **signature** against the pool's JWKS, then the
           issuer, audience, expiry and email domain
  dev      trust an `X-Dev-User` header, so the frontend can be built
           before Cognito exists

Dev mode needs THREE conditions: ALLOW_DEV_AUTH set, APP_ENV == "dev",
and no Cognito pool configured. The first is the one that matters --
terraform never sets it, so no deployed environment can reach the bypass
however the others drift.

Verifying claims but not the signature is the classic failure here (an
open finding in the DFIQ RBAC audit). `_verify` does the signature first
and will not proceed without it.
"""
from __future__ import annotations

import logging
import time
from typing import Annotated, Any

import httpx
import jwt
from fastapi import Depends, Header, HTTPException, status
from jwt import PyJWKClient

from costhub.audit import log as audit_log
from costhub.config import settings
from costhub.db import connect, fetch_one
from costhub.query.scoped import Principal

log = logging.getLogger(__name__)

_jwks: PyJWKClient | None = None
_jwks_url: str | None = None


def dev_mode() -> bool:
    """Is the X-Dev-User header accepted?

    Three conditions, and the third is the real one: ALLOW_DEV_AUTH is
    never set by terraform, so no deployed environment can reach this
    path regardless of how the other two drift.

    The previous two-condition version was not the defence it looked
    like: app_env defaulted to "dev" and terraform sets APP_ENV to the
    workspace name, so a deployed `dev` environment satisfied condition
    one permanently, leaving only the pool id between an unauthenticated
    public Function URL and a full superadmin bypass.
    """
    s = settings()
    return (
        s.allow_dev_auth
        and s.app_env == "dev"
        and not s.cognito_user_pool_id
    )


def _issuer() -> str:
    s = settings()
    return (
        f"https://cognito-idp.{s.aws_region}.amazonaws.com/"
        f"{s.cognito_user_pool_id}"
    )


def _jwk_client() -> PyJWKClient:
    global _jwks, _jwks_url
    url = f"{_issuer()}/.well-known/jwks.json"
    if _jwks is None or _jwks_url != url:
        _jwks = PyJWKClient(url, cache_keys=True)
        _jwks_url = url
    return _jwks


def _verify(token: str) -> dict[str, Any]:
    """Verify signature first, then the claims. Never the other way round."""
    try:
        key = _jwk_client().get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token,
            key=key,
            algorithms=["RS256"],
            issuer=_issuer(),
            audience=settings().cognito_client_id,
            options={
                "verify_signature": True,
                "verify_exp": True,
                "verify_iss": True,
                # Always verified. Making this conditional on the
                # client id meant an empty COGNITO_CLIENT_ID silently
                # downgraded verification with no visible signal.
                "verify_aud": True,
                "require": ["exp", "iss", "aud"],
            },
        )
    except (jwt.PyJWTError, httpx.HTTPError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"invalid token: {exc}")

    if claims.get("token_use") not in (None, "id", "access"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong token type")
    if claims.get("exp", 0) < time.time():
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token expired")
    return claims


def _email_from(claims: dict[str, Any]) -> str:
    """The caller's email, which must be verified.

    Cognito's `email` attribute is mutable, and a user with the
    `aws.cognito.signin.user.admin` scope can change their own. Without
    this check, setting it to a known superadmin's address and
    re-authenticating yielded that role -- `email_verified` goes false on
    change, which is exactly the signal to reject on.
    """
    email = claims.get("email") or claims.get("username") or claims.get("cognito:username")
    if not email:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token carries no email")

    # Only enforce where the claim exists: access tokens do not carry it,
    # and absence is not the same as false.
    if "email_verified" in claims and not claims["email_verified"]:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "email address is not verified",
        )
    return str(email).strip().lower()


def _load_user(email: str) -> Principal:
    allowed = settings().allowed_email_domain
    if allowed and not email.endswith(f"@{allowed}"):
        # Re-checked here as well as in the Cognito pre-signup trigger:
        # either one alone is a single point of failure.
        raise HTTPException(status.HTTP_403_FORBIDDEN, "email domain not permitted")

    row = fetch_one(
        """
        SELECT id, email, role, status
        FROM users
        WHERE email = %(e)s AND deleted_at IS NULL
        """,
        {"e": email},
    )
    if row is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "user not provisioned")
    if row["status"] == "disabled":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "user disabled")

    return Principal(user_id=str(row["id"]), email=row["email"], role=row["role"])


BYPASS_SEEN = """
SELECT 1 FROM audit_log
WHERE actor = %(actor)s
  AND action = 'access.superadmin_bypass'
  AND at > now() - interval '1 hour'
LIMIT 1
"""


def _audit_bypass(who: Principal) -> None:
    """Record that a superadmin read data outside any grant.

    FR-38. `scoped.SUPERADMIN_BYPASS` has always carried a comment saying
    callers log this; no caller did, so the detection control for every
    privilege-escalation path was simply absent.

    Throttled to one row per actor per hour: a dashboard issues half a
    dozen requests per page load, and a row each would bury the log it is
    meant to make readable.
    """
    try:
        with connect() as conn, conn.cursor() as cur:
            cur.execute(BYPASS_SEEN, {"actor": who.email})
            if cur.fetchone():
                return
            audit_log(
                cur,
                actor=who.email,
                action="access.superadmin_bypass",
                entity_type="user",
                entity_id=who.user_id,
                after={"role": who.role, "window": "1h", "throttled": True},
            )
    except Exception:
        # Never fail a request because the audit write failed -- but say
        # so loudly, because a silent gap here is the whole problem.
        log.exception("could not record superadmin bypass for %s", who.email)


async def principal(
    authorization: Annotated[str | None, Header()] = None,
    x_dev_user: Annotated[str | None, Header()] = None,
) -> Principal:
    """The authenticated caller. Built from the token, never a request body."""
    if authorization and authorization.lower().startswith("bearer "):
        claims = _verify(authorization.split(" ", 1)[1].strip())
        who = _load_user(_email_from(claims))
        if who.is_superadmin:
            _audit_bypass(who)
        return who

    if x_dev_user and dev_mode():
        who = _load_user(x_dev_user.strip().lower())
        if who.is_superadmin:
            _audit_bypass(who)
        return who

    raise HTTPException(
        status.HTTP_401_UNAUTHORIZED,
        "missing bearer token",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def superadmin(
    who: Annotated[Principal, Depends(principal)],
) -> Principal:
    if not who.is_superadmin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "superadmin required")
    return who


CurrentUser = Annotated[Principal, Depends(principal)]
SuperAdmin = Annotated[Principal, Depends(superadmin)]
