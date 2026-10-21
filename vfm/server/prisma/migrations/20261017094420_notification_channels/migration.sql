-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('EMAIL', 'WEBHOOK', 'SLACK_WEBHOOK');

-- CreateTable
CREATE TABLE "notification_channels" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ChannelType" NOT NULL,
    "config_encrypted" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_deliveries" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "channel_id" UUID,
    "channel_name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_channels_org_id_name_key" ON "notification_channels"("org_id", "name");

-- CreateIndex
CREATE INDEX "alert_deliveries_event_id_created_at_idx" ON "alert_deliveries"("event_id", "created_at");

-- CreateIndex
CREATE INDEX "alert_deliveries_org_id_idx" ON "alert_deliveries"("org_id");

-- AddForeignKey
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "alert_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "notification_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
