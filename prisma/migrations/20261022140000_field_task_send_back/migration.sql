-- Keystone can send a submitted field visit back to the agent; earlier attempts are kept.
ALTER TABLE "FieldTask" ADD COLUMN "reviewNote" TEXT;
ALTER TABLE "FieldTask" ADD COLUMN "returnedAt" TIMESTAMP(3);
ALTER TABLE "FieldTask" ADD COLUMN "returnCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "FieldTask" ADD COLUMN "history" JSONB NOT NULL DEFAULT '[]';
