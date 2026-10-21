-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "command_status" ADD VALUE 'PENDING_APPROVAL';
ALTER TYPE "command_status" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "clusters" ADD COLUMN     "require_restore_approval" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "commands" ADD COLUMN     "approved_by_id" UUID,
ADD COLUMN     "decided_at" TIMESTAMPTZ(6),
ADD COLUMN     "decision_note" TEXT,
ADD COLUMN     "rejected_by_id" UUID;
