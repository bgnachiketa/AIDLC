import { mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { AidlcError } from "./errors.js";
import { assertInside, readJson, readText, sha256, writeAtomic } from "./fsutil.js";
import { AIDLC_PATHS } from "./paths.js";
import {
  ActivePlanSchema,
  GeneratedManifestSchema,
  JournalSchema,
  SCHEMA_VERSION,
  formatZodError,
  type ActivePlanPointer,
  type GeneratedManifest,
  type Journal,
} from "./schema.js";

export async function loadActivePointer(root: string, relativePath = AIDLC_PATHS.activePlan): Promise<ActivePlanPointer | null> {
  const absolute = assertInside(root, relativePath);
  const text = await readText(absolute);
  if (text === null) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new AidlcError(`Active plan pointer is not valid JSON: ${relativePath}`, {
      code: "corrupt-state",
      recovery: "Run `aidlc plan-aidlc --repair` to quarantine the pointer. It was not deleted automatically.",
    });
  }
  return migrateActive(raw, relativePath);
}

export async function saveActivePointer(root: string, pointer: ActivePlanPointer, relativePath = AIDLC_PATHS.activePlan): Promise<void> {
  const checked = ActivePlanSchema.parse(pointer);
  await writeAtomic(assertInside(root, relativePath), `${JSON.stringify(checked, null, 2)}\n`);
}

export async function loadJournal(root: string): Promise<Journal> {
  const absolute = assertInside(root, AIDLC_PATHS.journal);
  const text = await readText(absolute);
  if (text === null) {
    return { schemaVersion: SCHEMA_VERSION, events: [] };
  }
  try {
    return JournalSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new AidlcError("Execution journal is corrupt", {
      code: "corrupt-state",
      recovery: "Run `aidlc plan-aidlc --repair` to quarantine .aidlc/state/journal.json.",
      details: { cause: error instanceof Error ? error.message : "unknown" },
    });
  }
}

export async function appendJournal(
  root: string,
  event: { type: string; message: string; planId: string | null; taskId: string | null; at: string },
): Promise<void> {
  const journal = await loadJournal(root);
  journal.events.push(event);
  if (journal.events.length > 500) {
    journal.events.splice(0, journal.events.length - 500);
    journal.events.unshift({
      at: event.at,
      type: "journal-rotated",
      message: "Older journal events were dropped after the 500 event cap.",
      planId: null,
      taskId: null,
    });
  }
  await writeAtomic(assertInside(root, AIDLC_PATHS.journal), `${JSON.stringify(journal, null, 2)}\n`);
}

export async function loadManifest(root: string): Promise<GeneratedManifest> {
  const absolute = assertInside(root, AIDLC_PATHS.generated);
  const text = await readText(absolute);
  if (text === null) {
    return { schemaVersion: SCHEMA_VERSION, files: {} };
  }
  try {
    return GeneratedManifestSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new AidlcError("Generated-file manifest is corrupt", {
      code: "corrupt-state",
      recovery: "Run `aidlc plan-aidlc --repair` before init. Existing generated files will not be overwritten.",
      details: { cause: error instanceof Error ? error.message : "unknown" },
    });
  }
}

export async function saveManifest(root: string, manifest: GeneratedManifest): Promise<void> {
  await writeAtomic(
    assertInside(root, AIDLC_PATHS.generated),
    `${JSON.stringify(GeneratedManifestSchema.parse(manifest), null, 2)}\n`,
  );
}

export function manifestOwns(manifest: GeneratedManifest, relativePath: string, content: string): boolean {
  return manifest.files[relativePath]?.sha256 === sha256(content);
}

export async function repairState(root: string): Promise<string[]> {
  const notes: string[] = [];
  const stateDir = assertInside(root, AIDLC_PATHS.stateDir);
  await mkdir(assertInside(root, AIDLC_PATHS.corruptDir), { recursive: true });
  let entries: string[] = [];
  try {
    entries = await readdir(stateDir);
  } catch {
    notes.push("No state directory was present.");
    return notes;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry === "corrupt") {
      continue;
    }
    const relative = `${AIDLC_PATHS.stateDir}/${entry}`;
    const absolute = assertInside(root, relative);
    try {
      const raw = await readJson(absolute);
      if (entry === "active-plan.json") migrateActive(raw, relative);
      if (entry === "journal.json") JournalSchema.parse(raw);
      if (entry === "generated.json") GeneratedManifestSchema.parse(raw);
    } catch (error) {
      const destination = assertInside(root, `${AIDLC_PATHS.corruptDir}/${Date.now()}-${entry}`);
      await rename(absolute, destination);
      notes.push(`Quarantined ${relative} to ${path.relative(root, destination)}: ${error instanceof Error ? error.message : "invalid"}`);
    }
  }
  const plansDir = assertInside(root, AIDLC_PATHS.plansDir);
  let plans: string[] = [];
  try {
    plans = await readdir(plansDir);
  } catch {
    plans = [];
  }
  const { PlanSchema, formatZodError: format } = await import("./schema.js");
  for (const entry of plans) {
    if (!entry.endsWith(".json")) continue;
    const relative = `${AIDLC_PATHS.plansDir}/${entry}`;
    try {
      const raw = await readJson(assertInside(root, relative));
      const parsed = PlanSchema.safeParse(raw);
      if (!parsed.success) {
        throw new AidlcError(format(parsed.error), { code: "corrupt-state" });
      }
    } catch (error) {
      const destination = assertInside(root, `${AIDLC_PATHS.corruptDir}/${Date.now()}-${entry}`);
      await rename(assertInside(root, relative), destination);
      notes.push(`Quarantined ${relative}: ${error instanceof Error ? error.message : "invalid"}`);
    }
  }
  const pointer = await loadActivePointer(root).catch(() => null);
  if (pointer) {
    const planFile = assertInside(root, `${AIDLC_PATHS.plansDir}/${pointer.planId}.json`);
    const text = await readText(planFile);
    if (text === null) {
      const destination = assertInside(root, `${AIDLC_PATHS.corruptDir}/${Date.now()}-active-plan.json`);
      await rename(assertInside(root, AIDLC_PATHS.activePlan), destination);
      notes.push(`Cleared dangling active pointer ${pointer.planId}.`);
    }
  }
  if (notes.length === 0) {
    notes.push("State files parsed successfully. Nothing was quarantined.");
  }
  return notes;
}

function migrateActive(raw: unknown, relativePath: string): ActivePlanPointer {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AidlcError(`Active pointer ${relativePath} is not an object`, {
      code: "corrupt-state",
      recovery: "Run plan-aidlc --repair. The pointer was left in place.",
    });
  }
  const version = "schemaVersion" in raw ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (version !== SCHEMA_VERSION) {
    throw new AidlcError(`Unsupported active pointer schemaVersion ${String(version)}`, {
      code: "unsupported-schema",
      recovery: "This build supports schemaVersion 1 and will not reset the pointer.",
    });
  }
  const parsed = ActivePlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AidlcError(`Invalid active pointer: ${formatZodError(parsed.error)}`, {
      code: "corrupt-state",
      recovery: "Run plan-aidlc --repair to quarantine the pointer.",
    });
  }
  return parsed.data;
}
