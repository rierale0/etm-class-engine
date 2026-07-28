CREATE TABLE "Job" (
    "id" UUID NOT NULL,
    "videoId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "requestPayload" JSONB NOT NULL,
    "resultJson" JSONB,
    "resultCharacterCount" INTEGER,
    "warnings" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "callbackStatus" TEXT NOT NULL DEFAULT 'pending',
    "callbackAttempts" INTEGER NOT NULL DEFAULT 0,
    "callbackLastError" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Job_idempotencyKey_key" ON "Job"("idempotencyKey");
CREATE INDEX "Job_videoId_idx" ON "Job"("videoId");
CREATE INDEX "Job_status_updatedAt_idx" ON "Job"("status", "updatedAt");

-- PostgreSQL partial uniqueness enforces one active job per video even during races.
CREATE UNIQUE INDEX "Job_one_active_video_key"
ON "Job"("videoId")
WHERE "status" NOT IN ('completed', 'failed');
