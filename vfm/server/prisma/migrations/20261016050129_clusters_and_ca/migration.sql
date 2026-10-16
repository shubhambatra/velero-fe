-- CreateEnum
CREATE TYPE "cluster_status" AS ENUM ('PENDING', 'ENROLLED', 'CONNECTED', 'DISCONNECTED', 'DISABLED');

-- CreateTable
CREATE TABLE "clusters" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "cluster_status" NOT NULL DEFAULT 'PENDING',
    "fingerprint" TEXT,
    "k8s_version" TEXT,
    "velero_version" TEXT,
    "velero_plugins" JSONB,
    "agent_version" TEXT,
    "protocol_version" INTEGER,
    "agent_policy" JSONB,
    "capabilities" JSONB,
    "last_seen_at" TIMESTAMPTZ(6),
    "labels" JSONB NOT NULL DEFAULT '{}',
    "grafana_url_template" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clusters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cluster_bootstrap_tokens" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cluster_bootstrap_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_certificates" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "serial" TEXT NOT NULL,
    "not_before" TIMESTAMPTZ(6) NOT NULL,
    "not_after" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificate_authority" (
    "id" INTEGER NOT NULL,
    "certificate_pem" TEXT NOT NULL,
    "key_encrypted" TEXT NOT NULL,
    "not_after" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificate_authority_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clusters_org_id_status_idx" ON "clusters"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "clusters_org_id_name_key" ON "clusters"("org_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "cluster_bootstrap_tokens_token_hash_key" ON "cluster_bootstrap_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "cluster_bootstrap_tokens_org_id_idx" ON "cluster_bootstrap_tokens"("org_id");

-- CreateIndex
CREATE INDEX "cluster_bootstrap_tokens_cluster_id_idx" ON "cluster_bootstrap_tokens"("cluster_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_certificates_serial_key" ON "agent_certificates"("serial");

-- CreateIndex
CREATE INDEX "agent_certificates_org_id_idx" ON "agent_certificates"("org_id");

-- CreateIndex
CREATE INDEX "agent_certificates_cluster_id_revoked_at_idx" ON "agent_certificates"("cluster_id", "revoked_at");

-- AddForeignKey
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cluster_bootstrap_tokens" ADD CONSTRAINT "cluster_bootstrap_tokens_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_certificates" ADD CONSTRAINT "agent_certificates_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "clusters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
