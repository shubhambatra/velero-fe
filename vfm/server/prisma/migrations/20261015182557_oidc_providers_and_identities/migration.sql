-- CreateTable
CREATE TABLE "oidc_providers" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret_encrypted" TEXT NOT NULL,
    "group_claim" TEXT,
    "mappings" JSONB NOT NULL DEFAULT '[]',
    "jit_enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "oidc_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oidc_identities" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "oidc_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "oidc_providers_org_id_idx" ON "oidc_providers"("org_id");

-- CreateIndex
CREATE INDEX "oidc_identities_org_id_idx" ON "oidc_identities"("org_id");

-- CreateIndex
CREATE INDEX "oidc_identities_user_id_idx" ON "oidc_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "oidc_identities_provider_id_subject_key" ON "oidc_identities"("provider_id", "subject");

-- AddForeignKey
ALTER TABLE "oidc_providers" ADD CONSTRAINT "oidc_providers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oidc_identities" ADD CONSTRAINT "oidc_identities_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "oidc_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oidc_identities" ADD CONSTRAINT "oidc_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
