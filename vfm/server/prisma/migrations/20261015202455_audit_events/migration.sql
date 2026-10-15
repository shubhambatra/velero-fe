-- CreateEnum
CREATE TYPE "audit_actor_type" AS ENUM ('USER', 'TOKEN', 'SYSTEM', 'AGENT');

-- CreateEnum
CREATE TYPE "audit_outcome" AS ENUM ('SUCCESS', 'DENIED', 'FAILED');

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "org_id" UUID,
    "actor_type" "audit_actor_type" NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "cluster_id" UUID,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "outcome" "audit_outcome" NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_events_org_id_id_idx" ON "audit_events"("org_id", "id");

-- CreateIndex
CREATE INDEX "audit_events_org_id_actor_id_idx" ON "audit_events"("org_id", "actor_id");

-- CreateIndex
CREATE INDEX "audit_events_org_id_cluster_id_idx" ON "audit_events"("org_id", "cluster_id");

-- CreateIndex
CREATE INDEX "audit_events_org_id_action_idx" ON "audit_events"("org_id", "action");

-- ---------------------------------------------------------------------------
-- Append-only enforcement (PLAN.md §9; docs/DECISIONS.md ADR-013).
--
-- A trigger, not only GRANTs, because the role that runs migrations usually
-- owns the table and an owner can always UPDATE it: revoking privileges from
-- the owner is a no-op. The trigger fires for the owner and for superusers.
-- (Disabling it is DDL, which the application role should not hold.)
--
-- Retention (the 400-day default) needs to DELETE old rows, so a separate
-- NOLOGIN role may do exactly that. UPDATE and TRUNCATE are refused for
-- everyone.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vfm_audit_retention') THEN
    CREATE ROLE vfm_audit_retention NOLOGIN;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  -- The migrating user cannot create roles. Every DELETE stays refused, which
  -- is the safe direction; retention can be wired up by an administrator.
  RAISE NOTICE 'vfm_audit_retention not created: insufficient privilege';
END
$$;

CREATE FUNCTION audit_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (
       current_user = 'vfm_audit_retention'
       OR EXISTS (
         SELECT 1
         FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.roleid
         JOIN pg_roles u ON u.oid = m.member
         WHERE r.rolname = 'vfm_audit_retention' AND u.rolname = current_user
       )
     ) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'audit_events is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();

REVOKE UPDATE, DELETE, TRUNCATE ON "audit_events" FROM PUBLIC;
