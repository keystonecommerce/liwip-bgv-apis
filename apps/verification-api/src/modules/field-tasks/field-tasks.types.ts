// Field-task lifecycle (PRD section 14.2). A task is assigned to a FIELD_AGENT,
// who accepts, arrives (GPS), and submits a structured outcome.
export const FIELD_TASK_STATUSES = [
  "PENDING_ASSIGNMENT",
  "ASSIGNED",
  "ACCEPTED",
  "REJECTED",
  "IN_PROGRESS",
  "SUBMITTED",
  "CANCELLED"
] as const;
export type FieldTaskStatus = (typeof FIELD_TASK_STATUSES)[number];

// Still waiting on a visit. SUBMITTED and CANCELLED tasks are closed.
export const OPEN_FIELD_TASK_STATUSES = ["PENDING_ASSIGNMENT", "ASSIGNED", "ACCEPTED", "IN_PROGRESS"] as const;

// The assignment board's views: open, open past the due date, submitted, cancelled.
export const FIELD_TASK_VIEWS = ["open", "overdue", "completed", "cancelled"] as const;
export type FieldTaskView = (typeof FIELD_TASK_VIEWS)[number];

// Structured field outcomes from PRD section 14.2.
export const FIELD_TASK_OUTCOMES = [
  "PERSON_MET",
  "FAMILY_MET",
  "NEIGHBOUR_CONFIRMED",
  "ADDRESS_EXISTS",
  "MOVED",
  "NOT_TRACEABLE",
  "REVISIT_REQUIRED"
] as const;
export type FieldTaskOutcome = (typeof FIELD_TASK_OUTCOMES)[number];

// How each outcome resolves the underlying verification check.
// REVISIT_REQUIRED keeps the task open and the check in manual review.
export const OUTCOME_RESOLUTION: Record<FieldTaskOutcome, "VERIFIED" | "FAILED" | "REVISIT"> = {
  PERSON_MET: "VERIFIED",
  FAMILY_MET: "VERIFIED",
  NEIGHBOUR_CONFIRMED: "VERIFIED",
  ADDRESS_EXISTS: "VERIFIED",
  MOVED: "FAILED",
  NOT_TRACEABLE: "FAILED",
  REVISIT_REQUIRED: "REVISIT"
};

// What an agent adds to a visit: photos (with GPS) and the signature of the person met.
export const EVIDENCE_KINDS = ["PHOTO", "SIGNATURE"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

// Verification types that produce a physical field-visit task.
export const FIELD_TASK_VERIFICATION_TYPES = ["CURRENT_ADDRESS"] as const;

export interface SubmitFieldTaskInput {
  outcome?: string;
  notes?: string;
}

// undefined keeps the current value, null clears it.
export interface AssignFieldTaskInput {
  vendorId?: string | null;
  agentId?: string | null;
  dueAt?: Date | null;
}

export interface ArriveInput {
  latitude?: number;
  longitude?: number;
}
