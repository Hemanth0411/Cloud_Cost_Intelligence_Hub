-- Alert rules/events and anomaly findings.

CREATE TABLE alert_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  owner_user_id  uuid NOT NULL REFERENCES users(id),
  scope_provider text,                   -- NULL = all
  scope_account  text,
  scope_service  text,
  type           text NOT NULL
                 CHECK (type IN ('threshold','forecast','digest','anomaly')),
  metric         text NOT NULL DEFAULT 'effective_cost',
  comparator     text CHECK (comparator IN ('gt','gte','lt','lte')),
  threshold_value numeric(18,6),
  window_days    integer NOT NULL DEFAULT 1,
  frequency      text NOT NULL DEFAULT 'daily'
                 CHECK (frequency IN ('immediate','daily','weekly','monthly')),
  channels       jsonb NOT NULL DEFAULT '["inapp"]'::jsonb,
  enabled        boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  deleted_at timestamptz,
  deleted_by text,
  revision   integer     NOT NULL DEFAULT 1
);

CREATE TABLE alert_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id        uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  fired_at       timestamptz NOT NULL DEFAULT now(),
  observed_value numeric(18,6),
  expected_value numeric(18,6),
  payload        jsonb,
  status         text NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new','read','dismissed')),
  delivered_at   timestamptz,
  delivery_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  revision   integer     NOT NULL DEFAULT 1
);

CREATE INDEX idx_alert_events_rule ON alert_events (rule_id, fired_at DESC);

-- kind matters: cloud cost anomalies are overwhelmingly 'step' (something
-- was switched on and stayed on), not 'spike'.
CREATE TABLE anomaly_findings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  account_id        text NOT NULL,
  service_name      text NOT NULL,
  detected_for_date date NOT NULL,
  method            text NOT NULL,       -- 'mad' | 'aws_cad'
  kind              text NOT NULL
                    CHECK (kind IN ('step','spike','creep')),
  baseline_value    numeric(18,6),
  observed_value    numeric(18,6),
  delta_abs         numeric(18,6),
  delta_pct         numeric(10,4),
  score             numeric(10,4),
  status            text NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new','acknowledged','dismissed')),
  acknowledged_by   text,
  acknowledged_at   timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  revision   integer     NOT NULL DEFAULT 1,
  UNIQUE (provider, account_id, service_name, detected_for_date, method)
);

CREATE INDEX idx_anomaly_open
  ON anomaly_findings (provider, account_id, detected_for_date DESC)
  WHERE status = 'new';
