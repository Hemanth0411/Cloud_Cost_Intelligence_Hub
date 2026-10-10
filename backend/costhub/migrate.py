"""Apply numbered .sql files in order, once each.

Deliberately not Alembic: the schema is small, the migrations are plain
SQL, and a 30-line runner has no behaviour to debug.

    python -m costhub.migrate
"""
from __future__ import annotations

import sys
from pathlib import Path

from costhub.db import connect

MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations"
BOOTSTRAP = """
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
"""


def main() -> int:
    files = sorted(MIGRATIONS.glob("*.sql"))
    if not files:
        print(f"no migrations found in {MIGRATIONS}")
        return 1

    with connect() as conn, conn.cursor() as cur:
        cur.execute(BOOTSTRAP)
        cur.execute("SELECT filename FROM schema_migrations")
        applied = {r["filename"] for r in cur.fetchall()}

        for path in files:
            if path.name in applied:
                print(f"  skip  {path.name}")
                continue
            print(f"  apply {path.name}")
            cur.execute(path.read_text(encoding="utf-8"))
            cur.execute(
                "INSERT INTO schema_migrations (filename) VALUES (%(f)s)",
                {"f": path.name},
            )
    print("migrations up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
