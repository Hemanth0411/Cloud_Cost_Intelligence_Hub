"""Settings, loaded from the environment (.env in dev)."""
from __future__ import annotations

import json
from functools import lru_cache

from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict


class CostAccount(BaseModel):
    """One cloud account we ingest from.

    The two accounts are independent (no AWS Organization), which is the
    whole point: each needs its own credentials and is fetched separately.
    """

    provider: str = "aws"
    account_id: str
    name: str
    profile: str | None = None   # local AWS CLI profile
    role_arn: str | None = None  # or a role to assume


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    database_url: str
    # NOT "dev": that default plus terraform's APP_ENV=<workspace>
    # meant a deployed dev environment permanently satisfied one of
    # the two dev-auth conditions. An insecure default is not a
    # default. See allow_dev_auth below.
    app_env: str = "prod"
    # Matches scoped.SYSTEM_EMAIL. Two different strings split the
    # audit trail: filtering by actor silently missed half the
    # machine writes.
    system_actor: str = "system@costhub.internal"
    cost_accounts: str = "[]"

    aws_region: str = "us-east-1"
    currency_fallback: str = "USD"
    allowed_email_domain: str = "chryselys.com"

    # Seeded as the first superadmin by migrate. Without it a fresh
    # environment has nobody who can invite anyone.
    superadmin_email: str = ""

    # Auth. The X-Dev-User header is accepted only when ALL THREE of
    # app_env=dev, no pool configured, and allow_dev_auth are true.
    # allow_dev_auth is never set by terraform, so no deployed
    # environment can reach the bypass however it is misconfigured.
    cognito_user_pool_id: str = ""
    allow_dev_auth: bool = False
    cognito_client_id: str = ""

    # Comma-separated allowed origins for the browser app.
    cors_origins: str = ""

    ses_sender_email: str = ""

    def accounts(self) -> list[CostAccount]:
        return [CostAccount(**a) for a in json.loads(self.cost_accounts)]


@lru_cache
def settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
