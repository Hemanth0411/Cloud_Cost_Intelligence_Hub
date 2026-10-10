"""Settings, loaded from the environment (.env in dev)."""
from __future__ import annotations

import json
from functools import lru_cache

from pydantic import BaseModel, Field
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
    app_env: str = "dev"
    system_actor: str = "system@costhub"
    cost_accounts: str = "[]"

    aws_region: str = "us-east-1"
    currency_fallback: str = "USD"

    def accounts(self) -> list[CostAccount]:
        return [CostAccount(**a) for a in json.loads(self.cost_accounts)]


@lru_cache
def settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
