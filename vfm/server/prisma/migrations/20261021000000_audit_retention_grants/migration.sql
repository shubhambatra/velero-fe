-- The retention role may read and delete audit events (docs/OPERATIONS.md, audit retention).
--
-- Migration 20261015202455 created the NOLOGIN role and the trigger that lets only that role DELETE, but
-- granted it nothing, so a purge would have been refused by the privilege check before the trigger ran. UPDATE
-- and TRUNCATE stay refused for everyone. Nothing is granted to the application's own role: whether it can
-- act as this role is the operator's decision (GRANT vfm_audit_retention TO <login>).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vfm_audit_retention') THEN
    GRANT SELECT, DELETE ON "audit_events" TO vfm_audit_retention;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'could not grant to vfm_audit_retention: insufficient privilege';
END
$$;
