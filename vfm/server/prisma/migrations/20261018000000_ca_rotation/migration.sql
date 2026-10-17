-- CreateEnum
CREATE TYPE "ca_state" AS ENUM ('ACTIVE', 'STAGED', 'RETIRING');

-- AlterTable
ALTER TABLE "certificate_authority" ADD COLUMN     "state" "ca_state" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "state_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;
