-- CreateTable
CREATE TABLE "velero_files" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "part" TEXT NOT NULL,
    "target_name" TEXT NOT NULL,
    "target_uid" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "command_id" UUID,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "velero_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "velero_files_expires_at_idx" ON "velero_files"("expires_at");

-- CreateIndex
CREATE INDEX "velero_files_org_id_idx" ON "velero_files"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "velero_files_cluster_id_part_target_name_target_uid_key" ON "velero_files"("cluster_id", "part", "target_name", "target_uid");

-- AddForeignKey
ALTER TABLE "velero_files" ADD CONSTRAINT "velero_files_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "velero_files" ADD CONSTRAINT "velero_files_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
