-- Seed the first superadmin from the SUPERADMIN_EMAIL environment
-- variable, so a fresh environment has somebody who can invite others.
--
-- Terraform creates the matching Cognito user (cognito.tf); this creates
-- the row the API resolves a token to. Both halves are required: without
-- the Cognito user no code can be sent, and without this row the API
-- rejects the token with "user not provisioned".
--
-- Idempotent, and deliberately does NOT demote an existing row.

CREATE OR REPLACE FUNCTION seed_superadmin(p_email text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_email IS NULL OR p_email = '' THEN
    RAISE NOTICE 'seed_superadmin: no email supplied, skipping';
    RETURN;
  END IF;

  INSERT INTO users (email, display_name, role, status, created_by, updated_by)
  VALUES (lower(trim(p_email)), 'Superadmin', 'superadmin', 'active',
          'migration:006', 'migration:006')
  ON CONFLICT (email) DO UPDATE
    SET role       = 'superadmin',
        status     = CASE WHEN users.status = 'disabled'
                          THEN users.status ELSE 'active' END,
        updated_at = now(),
        updated_by = 'migration:006',
        revision   = users.revision + 1;
END;
$$;
