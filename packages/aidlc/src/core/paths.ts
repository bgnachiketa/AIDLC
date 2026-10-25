export const AIDLC_PATHS = {
  config: ".aidlc/config.yaml",
  plansDir: ".aidlc/plans",
  stateDir: ".aidlc/state",
  activePlan: ".aidlc/state/active-plan.json",
  journal: ".aidlc/state/journal.json",
  generated: ".aidlc/state/generated.json",
  detection: ".aidlc/state/detection.json",
  proposedDir: ".aidlc/proposed",
  corruptDir: ".aidlc/state/corrupt",
} as const;
