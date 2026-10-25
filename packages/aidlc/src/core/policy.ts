import type { Policy } from "./schema.js";

export type PolicyAction = "fileChanges" | "shell" | "commit" | "network" | "pullRequest";

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export interface PolicyContext {
  yes: boolean;
  nonInteractive: boolean;
  tty: boolean;
  ask?: (prompt: string) => Promise<boolean>;
}

export async function decidePolicy(
  policy: Policy,
  action: PolicyAction,
  context: PolicyContext,
  prompt: string,
): Promise<PolicyDecision> {
  const level = policy[action];
  if (level === "deny") {
    return { allowed: false, reason: `Policy denies ${action}.` };
  }
  if (level === "allow") {
    return { allowed: true, reason: `Policy allows ${action}.` };
  }
  if (context.yes) {
    return { allowed: true, reason: `Approved by --yes for ${action}.` };
  }
  if (context.nonInteractive || !context.tty || !context.ask) {
    return {
      allowed: false,
      reason: `Policy prompts before ${action}, and this session cannot ask.`,
    };
  }
  const allowed = await context.ask(prompt);
  return {
    allowed,
    reason: allowed ? `Approved interactively for ${action}.` : `Declined interactively for ${action}.`,
  };
}

export function defaultPolicy(): Policy {
  return {
    fileChanges: "prompt",
    shell: "prompt",
    commit: "prompt",
    network: "prompt",
    pullRequest: "prompt",
    allowDestructive: false,
    allowFailedGateCommit: false,
  };
}
