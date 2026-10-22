-- Field-task assignment: when an agent was given the task, and cancellation.
ALTER TABLE "FieldTask" ADD COLUMN "assignedAt" TIMESTAMP(3);
ALTER TABLE "FieldTask" ADD COLUMN "cancelledAt" TIMESTAMP(3);
ALTER TABLE "FieldTask" ADD COLUMN "cancelReason" TEXT;
