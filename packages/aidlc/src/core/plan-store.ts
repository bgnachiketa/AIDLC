import { readdir } from "node:fs/promises";
import { AidlcError } from "./errors.js";
import { assertInside, readText, writeAtomic } from "./fsutil.js";
import { AIDLC_PATHS } from "./paths.js";
import {
  PlanSchema,
  SCHEMA_VERSION,
  formatZodError,
  type Plan,
} from "./schema.js";
import { renderPlanMarkdown } from "./plan-md.js";

export function planJsonPath(id: string): string {
  return `${AIDLC_PATHS.plansDir}/${id}.json`;
}

export function planMarkdownPath(id: string): string {
  return `${AIDLC_PATHS.plansDir}/${id}.md`;
}

export async function savePlan(root: string, plan: Plan): Promise<void> {
  const checked = PlanSchema.parse(plan);
  const json = `${JSON.stringify(checked, null, 2)}\n`;
  await writeAtomic(assertInside(root, planJsonPath(checked.id)), json);
  await writeAtomic(assertInside(root, planMarkdownPath(checked.id)), renderPlanMarkdown(checked));
}

export async function loadPlan(root: string, id: string): Promise<Plan> {
  const relative = planJsonPath(id);
  const text = await readText(assertInside(root, relative));
  if (text === null) {
    throw new AidlcError(`Plan ${id} was not found`, {
      code: "not-found",
      recovery: "Run plan-aidlc to create a plan, or plan-aidlc --list to see saved plans.",
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new AidlcError(`Plan file ${relative} is not valid JSON`, {
      code: "corrupt-state",
      recovery: "Fix the JSON or run plan-aidlc --repair to quarantine it. The file was not deleted.",
    });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AidlcError(`Plan file ${relative} is not an object`, { code: "corrupt-state" });
  }
  const version = "schemaVersion" in raw ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (version !== SCHEMA_VERSION) {
    throw new AidlcError(`Unsupported plan schemaVersion ${String(version)} in ${id}`, {
      code: "unsupported-schema",
      recovery: "This build migrates only schemaVersion 1. The plan file was not modified.",
    });
  }
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AidlcError(`Plan ${id} failed validation: ${formatZodError(parsed.error)}`, {
      code: "corrupt-state",
      recovery: "Correct the plan JSON or quarantine it with plan-aidlc --repair.",
    });
  }
  return parsed.data;
}

export async function listPlanIds(root: string): Promise<string[]> {
  const directory = assertInside(root, AIDLC_PATHS.plansDir);
  let entries: string[] = [];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
    .sort();
}
