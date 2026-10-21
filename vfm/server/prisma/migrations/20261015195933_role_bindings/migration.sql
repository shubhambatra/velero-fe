-- CreateEnum
CREATE TYPE "role_binding_subject" AS ENUM ('USER', 'TEAM');

-- CreateTable
CREATE TABLE "role_bindings" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "subject_type" "role_binding_subject" NOT NULL,
    "subject_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "role_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "role_bindings_org_id_cluster_id_idx" ON "role_bindings"("org_id", "cluster_id");

-- CreateIndex
CREATE INDEX "role_bindings_org_id_subject_type_subject_id_idx" ON "role_bindings"("org_id", "subject_type", "subject_id");

-- AddForeignKey
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
