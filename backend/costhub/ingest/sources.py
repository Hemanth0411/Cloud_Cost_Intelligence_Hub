"""Choosing an adapter for a connection.

The one place provider -> adapter is decided. Adding GCP means one entry
here and one new module; the runner, the CLI and the Lambda handler all
stay untouched. That is what the CostSource port was for.
"""
from __future__ import annotations

from typing import Callable

from costhub.connections.credentials import Connection
from costhub.ingest.azure_cm import AzureCostManagementSource
from costhub.ingest.cost_explorer import CostExplorerSource
from costhub.ingest.dev_seed import DevSeedSource
from costhub.ingest.errors import ExpectedIngestError

ADAPTERS: dict[str, Callable[[Connection], object]] = {
    "aws": lambda c: CostExplorerSource(c),
    "azure": lambda c: AzureCostManagementSource(c),
}


class NoAdapter(ExpectedIngestError):
    """A connection names a provider nothing can read.

    Expected rather than exceptional: somebody added a GCP connection
    before the adapter exists, and the run should report that clearly
    instead of stopping the other accounts.
    """


def source_for(conn: Connection):
    """The adapter for this connection's provider."""
    build = ADAPTERS.get(conn.provider)
    if build is None:
        raise NoAdapter(
            f"{conn.display_name}: no ingest adapter for provider "
            f"{conn.provider!r} (have: {', '.join(sorted(ADAPTERS))})"
        )
    return build(conn)


def dev_seed_for(conn: Connection) -> DevSeedSource:
    """Dev only -- generated data, never the demo's showcase fixtures."""
    return DevSeedSource(conn)
