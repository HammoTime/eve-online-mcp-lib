/** Stable machine-readable rules. Messages remain the existing user-facing text. */
export const INVARIANT_CODES = [
  "SKILL_EVIDENCE_INCOMPLETE",
  "SKILL_EVIDENCE_DUPLICATE",
  "QUEUE_LEVEL_DUPLICATE",
  "QUEUE_COMPLETED_CONFLICT",
  "QUEUE_TIME_ORDER",
  "QUEUE_SP_THRESHOLD",
  "PLAN_TARGET_UNSATISFIED",
  "PLAN_SP_BASELINE",
  "SKILL_GRAPH_LIMIT",
  "SKILL_GRAPH_NODE",
  "SKILL_GRAPH_CYCLE",
  "TRAINING_LEVEL_GAP",
  "TRAINING_PREREQUISITE_MISSING",
] as const;
export class DiagnosticError extends Error {
  constructor(
    readonly code: (typeof INVARIANT_CODES)[number],
    message: string,
  ) {
    super(message);
  }
}
