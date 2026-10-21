-- AlterTable
ALTER TABLE "clusters" ADD COLUMN "environment_type" TEXT NOT NULL DEFAULT 'other',
ADD COLUMN "api_endpoint" TEXT,
ADD COLUMN "owner" TEXT;
