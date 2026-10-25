import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { assertInside, readText, writeAtomic } from "./fsutil.js";
import { resolveRepository } from "./identity.js";
import { AIDLC_PATHS } from "./paths.js";
import { ARCHIVE_DIR } from "./archive.js";
import { decidePolicy, defaultPolicy, type PolicyContext } from "./policy.js";
import { failResult, okResult, type CommandResult } from "./result.js";
import { PlanSchema, type Plan } from "./schema.js";

const START = "<!-- aidlc:audit -->";
const END = "<!-- aidlc:end audit -->";
const CHANGELOG = "CHANGELOG.md";

export interface AuditRequest extends PolicyContext {
  cwd: string;
  dryRun?: boolean;
}

export interface AuditData {
  path: string;
  active: number;
  archived: number;
}

export async function writeAudit(input: AuditRequest): Promise<CommandResult<AuditData>> {
  const identity = await resolveRepository(input.cwd);
  const active = await readPlans(identity.root, AIDLC_PATHS.plansDir);
  const archived = await readPlans(identity.root, ARCHIVE_DIR);
  const data: AuditData = { path: CHANGELOG, active: active.length, archived: archived.length };
  const block = renderAudit(active, archived, new Date().toISOString());
  const current = await readText(assertInside(identity.root, CHANGELOG));
  const next = mergeChangelog(current, block);
  if (input.dryRun) {
    return okResult("dry-run", `Would write ${CHANGELOG} with ${active.length} active and ${archived.length} archived plans.`, data);
  }
  const config = await loadConfig(identity.root);
  const decision = await decidePolicy(
    config?.policy ?? defaultPolicy(),
    "fileChanges",
    input,
    `Write a brief audit to ${CHANGELOG}?`,
  );
  if (!decision.allowed) {
    return failResult(2, "policy-denied", decision.reason, data, "Re-run with --yes, or change policy.fileChanges.");
  }
  await writeAtomic(assertInside(identity.root, CHANGELOG), next);
  return okResult(
    "audited",
    `Wrote ${CHANGELOG} with ${active.length} active and ${archived.length} archived plans.`,
    data,
  );
}

function renderAudit(active: Plan[], archived: Plan[], at: string): string {
  const lines = [
    START,
    `## Audit ${at.slice(0, 10)}`,
    "",
    "Active plans",
    "",
    ...briefLines(active, "No active plans."),
    "",
    "Archived plans",
    "",
    ...briefLines(archived, "No archived plans."),
    "",
    END,
  ];
  return lines.join("\n");
}

function briefLines(plans: Plan[], empty: string): string[] {
  if (plans.length === 0) {
    return [`- ${empty}`];
  }
  return plans.map((plan) => {
    const brief = plan.requirements.replace(/\s+/g, " ").trim().slice(0, 120);
    return `- ${plan.id} — ${plan.title} — ${plan.status}${brief ? ` — ${brief}` : ""}`;
  });
}

export function mergeChangelog(current: string | null, block: string): string {
  const managed = `${block}\n`;
  if (!current) {
    return `# Changelog\n\nA short audit of plans in this repository.\n\n${managed}`;
  }
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  if (start !== -1 && end !== -1 && end > start) {
    return `${current.slice(0, start)}${managed}${current.slice(end + END.length).replace(/^\n/, "")}`;
  }
  return `${current.trimEnd()}\n\n${managed}`;
}

async function readPlans(root: string, directory: string): Promise<Plan[]> {
  const absolute = assertInside(root, directory);
  let names: string[] = [];
  try {
    names = await readdir(absolute);
  } catch {
    return [];
  }
  const plans: Plan[] = [];
  for (const name of names.filter((entry) => /^plan-[a-z0-9][a-z0-9-]*\.json$/.test(entry)).sort()) {
    const text = await readText(assertInside(root, path.join(directory, name)));
    if (!text) continue;
    try {
      const parsed = PlanSchema.safeParse(JSON.parse(text));
      if (parsed.success) plans.push(parsed.data);
    } catch {
      continue;
    }
  }
  return plans;
}

