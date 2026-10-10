"""Principal resolution -- the only place a Principal is constructed.

Two modes:

  cognito  verify the JWT **signature** against the pool's JWKS, then the
           issuer, audience, expiry and email domain
  dev      trust an `X-Dev-User` header, so the frontend can be built
           before Cognito exists

Dev mode is refused unless APP_ENV == "dev" *and* no pool is configured.
Both conditions, because either one alone is too easy to leave on.

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

from costhub.config import settings
from costhub.db import fetch_one
from costhub.query.scoped import Principal

log = logging.getLogger(__name__)

_jwks: PyJWKClient | None = None
_jwks_url: str | None = None


def dev_mode() -> bool:
    s = settings()
    return s.app_env == "dev" and not s.cognito_user_pool_id


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
            audience=settings().cognito_client_id or None,
            options={
                "verify_signature": True,
                "verify_exp": True,
                "verify_iss": True,
                "verify_aud": bool(settings().cognito_client_id),
                "require": ["exp", "iss"],
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
    email = claims.get("email") or claims.get("username") or claims.get("cognito:username")
    if not email:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token carries no email")
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


async def principal(
    authorization: Annotated[str | None, Header()] = None,
    x_dev_user: Annotated[str | None, Header()] = None,
) -> Principal:
    """The authenticated caller. Built from the token, never a request body."""
    if authorization and authorization.lower().startswith("bearer "):
        claims = _verify(authorization.split(" ", 1)[1].strip())
        return _load_user(_email_from(claims))

    if x_dev_user and dev_mode():
        return _load_user(x_dev_user.strip().lower())

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
