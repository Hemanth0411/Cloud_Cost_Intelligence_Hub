-- Registered cloud accounts. Backs the UI "Connect account" form.
-- No secret is stored here: assume_role needs none, and the key-based
-- fallback holds a Secrets Manager ARN, never a value.

CREATE TABLE cloud_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         text NOT NULL,          -- 'aws' | 'azure' | 'gcp'
  account_id       text NOT NULL,          -- 'self' = the deploy account
  display_name     text NOT NULL,
  credential_mode  text NOT NULL DEFAULT 'assume_role'
                   CHECK (credential_mode IN ('self','assume_role','profile','secret')),
  role_arn         text,                   -- assume_role
  external_id      text,                   -- confused-deputy protection
  profile_name     text,                   -- local dev only
  secret_arn       text,                   -- an ARN, never a credential
  enabled          boolean NOT NULL DEFAULT true,
  last_ingest_at     timestamptz,
  last_ingest_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  deleted_at timestamptz,
  deleted_by text,
  revision   integer     NOT NULL DEFAULT 1,
  UNIQUE (provider, account_id),
  CHECK (credential_mode <> 'assume_role' OR role_arn IS NOT NULL)
);

CREATE INDEX idx_connections_enabled
  ON cloud_connections (provider, account_id)
  WHERE enabled AND deleted_at IS NULL;

ALTER TABLE ingest_runs
  ADD COLUMN connection_id uuid REFERENCES cloud_connections(id);
