-- AlterTable
ALTER TABLE "clusters" ADD COLUMN     "inventory_snapshot_id" TEXT,
ADD COLUMN     "inventory_synced_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "velero_resources" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "resource_version" TEXT NOT NULL,
    "creation_timestamp" TIMESTAMPTZ(6),
    "phase" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "spec" JSONB NOT NULL DEFAULT '{}',
    "status" JSONB NOT NULL DEFAULT '{}',
    "labels" JSONB NOT NULL DEFAULT '{}',
    "created_by_vfm" BOOLEAN NOT NULL DEFAULT false,
    "snapshot_id" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "velero_resources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "velero_resources_cluster_id_kind_phase_idx" ON "velero_resources"("cluster_id", "kind", "phase");

-- CreateIndex
CREATE INDEX "velero_resources_cluster_id_kind_started_at_idx" ON "velero_resources"("cluster_id", "kind", "started_at");

-- CreateIndex
CREATE INDEX "velero_resources_cluster_id_kind_completed_at_idx" ON "velero_resources"("cluster_id", "kind", "completed_at");

-- CreateIndex
CREATE INDEX "velero_resources_org_id_idx" ON "velero_resources"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "velero_resources_cluster_id_kind_namespace_name_key" ON "velero_resources"("cluster_id", "kind", "namespace", "name");

-- AddForeignKey
ALTER TABLE "velero_resources" ADD CONSTRAINT "velero_resources_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "velero_resources" ADD CONSTRAINT "velero_resources_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
