CREATE TABLE "AnalysisBatch" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "callbackStatus" TEXT NOT NULL DEFAULT 'not_sent',
    "callbackAttempts" INTEGER NOT NULL DEFAULT 0,
    "callbackLastError" TEXT,
    "resultHash" TEXT,
    "resultCharacterCount" INTEGER,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnalysisBatch_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Job"
ADD COLUMN "batchId" UUID,
ADD COLUMN "batchPosition" INTEGER;

-- Preserve terminal results in the new local dashboard as one-class batches.
INSERT INTO "AnalysisBatch" (
    "id",
    "name",
    "callbackStatus",
    "callbackAttempts",
    "callbackLastError",
    "resultCharacterCount",
    "sentAt",
    "createdAt",
    "updatedAt"
)
SELECT
    "id",
    COALESCE(NULLIF("requestPayload"->>'title', ''), 'Imported class'),
    "callbackStatus",
    "callbackAttempts",
    "callbackLastError",
    "resultCharacterCount",
    CASE WHEN "callbackStatus" = 'sent' THEN "completedAt" ELSE NULL END,
    "createdAt",
    "updatedAt"
FROM "Job"
WHERE "status" IN ('completed', 'failed');

UPDATE "Job"
SET "batchId" = "id", "batchPosition" = 0
WHERE "status" IN ('completed', 'failed');

CREATE INDEX "AnalysisBatch_createdAt_idx" ON "AnalysisBatch"("createdAt");
CREATE INDEX "Job_batchId_batchPosition_idx" ON "Job"("batchId", "batchPosition");
CREATE UNIQUE INDEX "Job_batchId_videoId_key" ON "Job"("batchId", "videoId");

ALTER TABLE "Job"
ADD CONSTRAINT "Job_batchId_fkey"
FOREIGN KEY ("batchId") REFERENCES "AnalysisBatch"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
