-- Cost facts: the daily rollup plus ingest lineage.

-- Every write to fact_cost_daily belongs to exactly one run.
CREATE TABLE ingest_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL,            -- 'cost_explorer' | 'focus' | 'mock'
  provider     text NOT NULL,
  account_id   text,
  period_start date NOT NULL,
  period_end   date NOT NULL,
  status       text NOT NULL DEFAULT 'running'
               CHECK (status IN ('running','success','failed')),
  rows_written integer,
  error        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  triggered_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  revision   integer     NOT NULL DEFAULT 1
);

CREATE TABLE dim_account (
  provider     text NOT NULL,
  account_id   text NOT NULL,
  account_name text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  revision   integer     NOT NULL DEFAULT 1,
  PRIMARY KEY (provider, account_id)
);

CREATE TABLE dim_service (
  provider         text NOT NULL,
  service_name     text NOT NULL,
  service_category text,                 -- FOCUS ServiceCategory
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  revision   integer     NOT NULL DEFAULT 1,
  PRIMARY KEY (provider, service_name)
);

-- Grain: date x provider x account x service x region x charge_category.
-- Column names follow FOCUS so the FOCUS-export adapter drops in later.
-- numeric, never float -- this is money.
CREATE TABLE fact_cost_daily (
  id              bigserial PRIMARY KEY,
  provider        text NOT NULL,
  account_id      text NOT NULL,
  service_name    text NOT NULL,
  region          text NOT NULL DEFAULT '',
  charge_category text NOT NULL DEFAULT 'Usage',
  usage_date      date NOT NULL,
  billed_cost     numeric(18,6) NOT NULL,
  effective_cost  numeric(18,6) NOT NULL,
  currency        char(3) NOT NULL,
  -- lineage: for machine-written rows this IS the audit trail
  ingest_run_id   uuid NOT NULL REFERENCES ingest_runs(id),
  source          text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  deleted_at timestamptz,
  deleted_by text,
  revision   integer     NOT NULL DEFAULT 1,
  -- natural key: makes re-ingestion idempotent (ON CONFLICT DO UPDATE).
  -- Cost data is restated as it finalizes, so we WILL re-fetch days.
  UNIQUE (provider, account_id, service_name, region,
          charge_category, usage_date, currency)
);

CREATE INDEX idx_fact_scope
  ON fact_cost_daily (provider, account_id, usage_date)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_fact_service
  ON fact_cost_daily (provider, account_id, service_name, usage_date)
  WHERE deleted_at IS NULL;
