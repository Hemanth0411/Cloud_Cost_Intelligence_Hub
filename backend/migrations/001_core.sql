-- Core: migration tracking, identity, access grants, audit log.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- users
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,          -- normalized lowercase
  display_name  text,
  role          text NOT NULL DEFAULT 'user'
                CHECK (role IN ('superadmin','user')),
  status        text NOT NULL DEFAULT 'invited'
                CHECK (status IN ('invited','active','disabled')),
  last_login_at timestamptz,
  -- audit
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  deleted_at timestamptz,
  deleted_by text,
  revision   integer     NOT NULL DEFAULT 1
);

-- One user, many login methods. Grants reference users.id, never the
-- IdP subject -- this is what makes adding Microsoft OAuth an INSERT
-- rather than a migration.
CREATE TABLE identities (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,                      -- 'cognito' | 'microsoft'
  subject  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  deleted_at timestamptz,
  deleted_by text,
  revision   integer     NOT NULL DEFAULT 1,
  UNIQUE (provider, subject)
);

-- ------------------------------------------------------- access grants
-- service_name NULL = all services in that account.
-- valid_until  NULL = indefinite.
CREATE TABLE access_grants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     text NOT NULL,
  account_id   text NOT NULL,
  service_name text,
  valid_from   timestamptz NOT NULL DEFAULT now(),
  valid_until  timestamptz,
  revoked_at   timestamptz,
  revoked_by   text,
  reason       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  deleted_at timestamptz,
  deleted_by text,
  revision   integer     NOT NULL DEFAULT 1,
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);

CREATE INDEX idx_grants_lookup
  ON access_grants (user_id, provider, account_id)
  WHERE revoked_at IS NULL AND deleted_at IS NULL;

-- ----------------------------------------------------------- audit log
-- Append-only, enforced by statement-level triggers in 005.
--
-- NOT by GRANT. Revoking UPDATE/DELETE from the app role is the textbook
-- answer and it is not available here: the app connects as the Neon
-- owner role, which cannot have its own privileges revoked, and a
-- hackathon deployment has no second role to switch to. This comment
-- claimed the GRANT for a while, which was the worst of both -- anyone
-- reading it would have believed the table was protected by something
-- that had never been applied.
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor       text NOT NULL,
  action      text NOT NULL,                   -- 'grant.create', 'user.disable'
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  before      jsonb,
  after       jsonb,
  request_id  text,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id, at DESC);
CREATE INDEX idx_audit_actor  ON audit_log (actor, at DESC);
