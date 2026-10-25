import { mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { assertInside, pathExists, readText, writeAtomic } from "./fsutil.js";
import { resolveRepository } from "./identity.js";
import { AIDLC_PATHS } from "./paths.js";
import { loadPlan, planJsonPath, planMarkdownPath } from "./plan-store.js";
import { decidePolicy, defaultPolicy, type PolicyContext } from "./policy.js";
import { failResult, okResult, type CommandResult } from "./result.js";
import { appendJournal, loadActivePointer } from "./state.js";

export const ARCHIVE_DIR = ".github/aidlc/archive";

export interface ArchiveRequest extends PolicyContext {
  cwd: string;
  planId?: string;
  dryRun?: boolean;
}

export interface ArchiveData {
  planId: string | null;
  from: string | null;
  to: string | null;
}

export async function archivePlan(input: ArchiveRequest): Promise<CommandResult<ArchiveData>> {
  const identity = await resolveRepository(input.cwd);
  const pointer = await loadActivePointer(identity.root);
  const planId = input.planId ?? pointer?.planId ?? null;
  const empty: ArchiveData = { planId, from: null, to: null };
  if (!planId) {
    return failResult(2, "no-plan", "No plan is selected to archive.", empty, "Create a plan with plan-aidlc, or pass --plan <id>.");
  }
  const sourceJson = planJsonPath(planId);
  const sourceMarkdown = planMarkdownPath(planId);
  const destinationJson = `${ARCHIVE_DIR}/${planId}.json`;
  const destinationMarkdown = `${ARCHIVE_DIR}/${planId}.md`;
  const located: ArchiveData = { planId, from: sourceJson, to: destinationJson };
  if (!(await pathExists(assertInside(identity.root, sourceJson)))) {
    if (await pathExists(assertInside(identity.root, destinationJson))) {
      return failResult(2, "already-archived", `Plan ${planId} is already in ${ARCHIVE_DIR}.`, located);
    }
    return failResult(2, "not-found", `Plan ${planId} was not found in .aidlc/plans.`, located, "Run plan-aidlc --list to see active plans.");
  }
  const plan = await loadPlan(identity.root, planId);
  if (input.dryRun) {
    return okResult("dry-run", `Would move ${plan.id} to ${destinationJson}.`, located);
  }
  const config = await loadConfig(identity.root);
  const decision = await decidePolicy(
    config?.policy ?? defaultPolicy(),
    "fileChanges",
    input,
    `Move plan ${plan.id} to ${ARCHIVE_DIR}?`,
  );
  if (!decision.allowed) {
    return failResult(2, "policy-denied", decision.reason, located, "Re-run with --yes, or change policy.fileChanges.");
  }
  const archiveRoot = assertInside(identity.root, ARCHIVE_DIR);
  await mkdir(archiveRoot, { recursive: true });
  const readme = path.join(archiveRoot, "README.md");
  if (!(await pathExists(readme))) {
    await writeAtomic(
      readme,
      "# Archived plans\n\n`archive-aidlc` moves a plan here from `.aidlc/plans`. The JSON file remains the record of that plan.\n",
    );
  }
  await rename(assertInside(identity.root, sourceJson), assertInside(identity.root, destinationJson));
  const markdown = assertInside(identity.root, sourceMarkdown);
  if (await pathExists(markdown)) {
    await rename(markdown, assertInside(identity.root, destinationMarkdown));
  }
  if (pointer?.planId === plan.id) {
    await unlink(assertInside(identity.root, AIDLC_PATHS.activePlan)).catch(() => undefined);
  }
  const now = new Date().toISOString();
  await appendJournal(identity.root, {
    at: now,
    type: "plan-archived",
    message: `Moved ${plan.id} (${plan.title}) to ${destinationJson}.`,
    planId: plan.id,
    taskId: null,
  });
  return okResult("archived", `Archived ${plan.id} — ${plan.title} — to ${destinationJson}.`, located);
}

export async function readArchivedPlan(root: string, planId: string): Promise<string | null> {
  return readText(assertInside(root, `${ARCHIVE_DIR}/${planId}.json`));
}
