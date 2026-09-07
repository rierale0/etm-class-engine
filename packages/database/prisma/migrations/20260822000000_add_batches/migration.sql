CREATE TABLE "Batch" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "deliveryStatus" TEXT NOT NULL DEFAULT 'not_sent',
    "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "deliveryLastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Job"
ADD COLUMN "batchId" UUID,
ADD COLUMN "batchOrder" INTEGER;

CREATE UNIQUE INDEX "Batch_idempotencyKey_key" ON "Batch"("idempotencyKey");
CREATE INDEX "Batch_createdAt_idx" ON "Batch"("createdAt");
CREATE INDEX "Batch_deliveryStatus_idx" ON "Batch"("deliveryStatus");
CREATE INDEX "Job_batchId_batchOrder_idx" ON "Job"("batchId", "batchOrder");

ALTER TABLE "Job"
ADD CONSTRAINT "Job_batchId_fkey"
FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
