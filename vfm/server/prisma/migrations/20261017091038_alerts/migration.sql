-- CreateEnum
CREATE TYPE "AlertRuleType" AS ENUM ('BACKUP_FAILED', 'SCHEDULE_MISSED', 'AGENT_DISCONNECTED', 'BSL_UNAVAILABLE', 'BACKUP_EXPIRING');

-- CreateEnum
CREATE TYPE "AlertState" AS ENUM ('FIRING', 'RESOLVED');

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AlertRuleType" NOT NULL,
    "scope" JSONB NOT NULL DEFAULT '{}',
    "params" JSONB NOT NULL DEFAULT '{}',
    "channel_ids" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_events" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "state" "AlertState" NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "fired_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "last_notified_at" TIMESTAMPTZ(6),

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_rules_org_id_idx" ON "alert_rules"("org_id");

-- CreateIndex
CREATE INDEX "alert_events_org_id_fired_at_idx" ON "alert_events"("org_id", "fired_at");

-- CreateIndex
CREATE INDEX "alert_events_rule_id_state_idx" ON "alert_events"("rule_id", "state");

-- CreateIndex
CREATE INDEX "alert_events_cluster_id_idx" ON "alert_events"("cluster_id");

-- AddForeignKey
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one open occurrence per rule and condition: two evaluations racing to fire the same
-- condition cannot both succeed, and the loser sees the unique violation instead of a duplicate.
CREATE UNIQUE INDEX "alert_events_open_key" ON "alert_events"("rule_id", "fingerprint") WHERE "state" = 'FIRING';
