-- Ledger for GET /insights model calls: the cache AND the meter.
--
-- Insert-only, one row per call ATTEMPT. A row is written as 'pending'
-- BEFORE Bedrock is called -- which is what proves this table can be
-- written before any money is spent -- and is then marked 'done' or
-- 'failed'. Nothing is ever upserted, so counting rows counts calls:
-- an earlier draft upserted by cache key and metered one row for ten
-- concurrent calls.
--
-- `result` holds the model's CHOICES only: {"choices": {card id: index},
-- "lead": card id}. Never a figure, a service name, or a sentence -- the
-- sentences are written by costhub/insights/frames.py and the figures
-- are recomputed through query/scoped on every request, so this table
-- cannot serve a number to someone whose grant was revoked.
--
-- Not an audited business table, so it carries no created_by / revision
-- columns: rows are derived and are pruned after 8 days.

CREATE TABLE insight_narrations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key     text        NOT NULL,      -- sha256, see cache.key()
  user_id       text        NOT NULL,
  model_id      text        NOT NULL,
  status        text        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','done','failed')),
  result        jsonb,
  input_tokens  integer     NOT NULL DEFAULT 0,
  output_tokens integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz
);

-- At most one call in flight per key: the second identical request sees
-- the first one's reservation and does not pay for a duplicate.
CREATE UNIQUE INDEX uq_insight_narrations_pending
  ON insight_narrations (cache_key) WHERE status = 'pending';

CREATE INDEX idx_insight_narrations_lookup
  ON insight_narrations (cache_key, created_at DESC);

CREATE INDEX idx_insight_narrations_created
  ON insight_narrations (created_at DESC);
