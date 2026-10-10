-- Make audit_log append-only at the database level, not by convention.
-- NFR-4 / TODO-10.
--
-- Revoking UPDATE and DELETE from PUBLIC is the portable way to do this:
-- Neon and RDS hand us an owner role, and an owner keeps implicit rights
-- on its own tables, so a trigger is the belt to that braces.

CREATE OR REPLACE FUNCTION audit_log_is_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();

REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;
