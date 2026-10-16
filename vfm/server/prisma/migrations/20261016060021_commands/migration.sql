-- CreateEnum
CREATE TYPE "command_status" AS ENUM ('QUEUED', 'SENT', 'ACKED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT');

-- CreateTable
CREATE TABLE "commands" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "requested_by_id" UUID,
    "op" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "command_status" NOT NULL DEFAULT 'QUEUED',
    "error_code" TEXT,
    "error_message" TEXT,
    "result" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "deadline_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),
    "acked_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commands_cluster_id_status_idx" ON "commands"("cluster_id", "status");

-- CreateIndex
CREATE INDEX "commands_org_id_created_at_idx" ON "commands"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "commands_status_deadline_at_idx" ON "commands"("status", "deadline_at");

-- AddForeignKey
ALTER TABLE "commands" ADD CONSTRAINT "commands_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commands" ADD CONSTRAINT "commands_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
