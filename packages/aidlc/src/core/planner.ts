import { randomBytes } from "node:crypto";
import { detectRepository, skillsFor, type DetectionReport, type ProjectDetection } from "./detect.js";
import { AidlcError } from "./errors.js";
import { createGitClient } from "./git.js";
import { resolveRepository, sameRepository, type RepositoryIdentity } from "./identity.js";
import { loadPlan, listPlanIds, savePlan } from "./plan-store.js";
import { failResult, okResult, type CommandResult } from "./result.js";
import {
  TERMINAL_PLAN_STATUSES,
  type ChangeType,
  type Plan,
  type PlanStatus,
  type Task,
} from "./schema.js";
import { appendJournal, loadActivePointer, repairState, saveActivePointer } from "./state.js";
import { AIDLC_PATHS } from "./paths.js";

export interface PlanRequest {
  cwd: string;
  requirement?: string;
  title?: string;
  changeType?: ChangeType;
  answers?: Record<string, string>;
  approve?: boolean;
  acceptAssumptions?: boolean;
  switchPlan?: boolean;
  revise?: boolean;
  planId?: string;
  list?: boolean;
  show?: boolean;
  select?: string;
  cancel?: boolean;
  repair?: boolean;
  dryRun?: boolean;
  now?: Date;
  createId?: (date: Date) => string;
}

export interface PlanData {
  plan: Plan | null;
  plans: Array<{ id: string; title: string; status: PlanStatus; changeType: ChangeType }>;
  resumed: boolean;
  repairNotes: string[];
}

export function classifyChange(text: string): { type: ChangeType; confidence: "high" | "medium" } {
  const rules: Array<{ type: ChangeType; pattern: RegExp; confidence: "high" | "medium" }> = [
    { type: "security", pattern: /\b(cve|xss|csrf|ssrf|vulnerab\w*|security fix|injection|authn|authz)\b/i, confidence: "high" },
    { type: "bugfix", pattern: /\b(bug|fix|regression|broken|incorrect|fails)\b/i, confidence: "high" },
    { type: "performance", pattern: /\b(performance|slow|latency|throughput|n\+1)\b/i, confidence: "high" },
    { type: "refactor", pattern: /\b(refactor|cleanup|restructure)\b/i, confidence: "high" },
    { type: "infrastructure", pattern: /\b(ci\b|pipeline|github action|docker|terraform|infra(?:structure)?)\b/i, confidence: "high" },
    { type: "documentation", pattern: /\b(readme|docs?|documentation)\b/i, confidence: "medium" },
  ];
  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      return { type: rule.type, confidence: rule.confidence };
    }
  }
  return { type: "feature", confidence: "medium" };
}

export function createPlanId(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `plan-${year}${month}${day}-${randomBytes(3).toString("hex")}`;
}

export function normalizeRequirement(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export async function planChange(input: PlanRequest): Promise<CommandResult<PlanData>> {
  const now = input.now ?? new Date();
  const empty: PlanData = { plan: null, plans: [], resumed: false, repairNotes: [] };
  if (input.repair) {
    const notes = input.dryRun ? ["Dry run: state repair was not applied."] : await repairState(input.cwd);
    return okResult("repaired", notes.join("\n"), { ...empty, repairNotes: notes });
  }
  const identity = await resolveRepository(input.cwd);
  if (input.list) {
    const plans = await summarizePlans(identity.root);
    const message = plans.length === 0 ? "No plans are stored." : plans.map((plan) => `${plan.id} ${plan.status} ${plan.title}`).join("\n");
    return okResult("plans", message, { ...empty, plans });
  }
  const creating = Boolean(input.requirement?.trim()) && !input.revise && !input.select && !input.cancel && !input.show;
  const hasAnswers = Boolean(input.answers && Object.keys(input.answers).length > 0);
  if (!creating && (hasAnswers || input.show || input.select || input.cancel || input.approve || input.revise)) {
    return mutateExisting(input, identity, now, empty);
  }
  return createPlan(input, identity, now, empty);
}

async function mutateExisting(
  input: PlanRequest,
  identity: RepositoryIdentity,
  now: Date,
  empty: PlanData,
): Promise<CommandResult<PlanData>> {
  if (input.select) {
    const plan = await loadPlan(identity.root, input.select);
    assertSameRepo(plan, identity);
    if (!input.dryRun) {
      await saveActivePointer(identity.root, pointerFor(plan, now));
      await appendJournal(identity.root, journal(now, "plan-selected", `Selected ${plan.id}`, plan.id, null));
    }
    return okResult("selected", `Active plan is ${plan.id}.`, { ...empty, plan });
  }
  const plan = await loadRequestedPlan(identity.root, input.planId);
  assertSameRepo(plan, identity);
  if (input.answers && Object.keys(input.answers).length > 0) {
    applyAnswers(plan, input.answers);
    if (unresolvedBlocking(plan)) {
      plan.status = "needs-clarification";
      plan.approval = { status: "pending", at: null, note: null };
    } else if (plan.approval.status !== "approved") {
      plan.status = "awaiting-approval";
      plan.approval = { status: "pending", at: null, note: null };
    }
    plan.updatedAt = now.toISOString();
  }
  if (input.show && !input.cancel && !input.approve && !input.revise) {
    if (!input.dryRun && input.answers && Object.keys(input.answers).length > 0) {
      await savePlan(identity.root, plan);
    }
    return okResult("plan", renderBrief(plan), { ...empty, plan });
  }
  if (input.cancel) {
    plan.status = "cancelled";
    plan.updatedAt = now.toISOString();
    plan.revisions.push({ at: plan.updatedAt, summary: "Cancelled by plan-aidlc --cancel." });
    if (!input.dryRun) {
      await savePlan(identity.root, plan);
      await appendJournal(identity.root, journal(now, "plan-cancelled", `Cancelled ${plan.id}`, plan.id, null));
    }
    return okResult("cancelled", `Cancelled ${plan.id}.`, { ...empty, plan });
  }
  if (input.revise) {
    if (input.requirement) {
      plan.requirements = input.requirement.trim();
      plan.problemStatement = problemStatement(plan.changeType, plan.requirements);
      plan.revisions.push({
        at: now.toISOString(),
        summary: "Requirements changed. Re-check acceptance criteria for completed tasks before relying on earlier evidence.",
      });
      plan.risks.push("Requirements changed after planning. Completed tasks may no longer satisfy the new acceptance criteria.");
    }
    if (input.title) plan.title = input.title;
    if (input.changeType) plan.changeType = input.changeType;
    applyAnswers(plan, input.answers ?? {});
    plan.approval = { status: "pending", at: null, note: null };
    plan.status = unresolvedBlocking(plan) ? "needs-clarification" : "awaiting-approval";
    plan.updatedAt = now.toISOString();
  }
  if (input.approve) {
    applyAnswers(plan, input.answers ?? {});
    if (input.acceptAssumptions) {
      acceptBlocking(plan);
    }
    if (unresolvedBlocking(plan)) {
      plan.status = "needs-clarification";
      plan.updatedAt = now.toISOString();
      if (!input.dryRun) await savePlan(identity.root, plan);
      return failResult(
        2,
        "needs-clarification",
        `Cannot approve ${plan.id} while blocking questions remain.`,
        { ...empty, plan },
        "Answer the questions with --answer id=value or pass --accept-assumptions to record them explicitly.",
      );
    }
    plan.approval = {
      status: "approved",
      at: now.toISOString(),
      note: "Approved with plan-aidlc --approve.",
    };
    plan.status = "approved";
    plan.updatedAt = now.toISOString();
  }
  if (!input.dryRun) {
    await savePlan(identity.root, plan);
    await saveActivePointer(identity.root, pointerFor(plan, now));
  }
  return okResult(plan.status, renderBrief(plan), { ...empty, plan });
}

async function createPlan(
  input: PlanRequest,
  identity: RepositoryIdentity,
  now: Date,
  empty: PlanData,
): Promise<CommandResult<PlanData>> {
  const requirement = (input.requirement ?? "").trim();
  if (!requirement) {
    return failResult(2, "needs-clarification", "A requirement is required to create a plan.", empty, "Pass the requirement after the command flags.");
  }
  const detection = await detectRepository(identity.root);
  const classified = input.changeType ? { type: input.changeType, confidence: "high" as const } : classifyChange(requirement);
  const active = await loadActivePointer(identity.root).catch((error: unknown) => {
    if (error instanceof AidlcError && (error.code === "corrupt-state" || error.code === "unsupported-schema")) {
      throw error;
    }
    return null;
  });
  if (active) {
    const activePlan = await loadPlan(identity.root, active.planId).catch((error: unknown) => {
      if (error instanceof AidlcError && error.code === "not-found") {
        return null;
      }
      throw error;
    });
    if (activePlan && !TERMINAL_PLAN_STATUSES.includes(activePlan.status)) {
      const equivalent =
        activePlan.changeType === classified.type &&
        normalizeRequirement(activePlan.requirements) === normalizeRequirement(requirement);
      if (equivalent) {
        applyAnswers(activePlan, input.answers ?? {});
        if (input.acceptAssumptions) acceptBlocking(activePlan);
        refreshStatus(activePlan, Boolean(input.approve));
        activePlan.updatedAt = now.toISOString();
        if (!input.dryRun) await savePlan(identity.root, activePlan);
        const blocked = unresolvedBlocking(activePlan);
        if (blocked) {
          return failResult(2, "needs-clarification", renderBrief(activePlan), { ...empty, plan: activePlan, resumed: true }, "Answer the remaining blocking questions.");
        }
        return okResult("resumed", `Resumed equivalent plan ${activePlan.id}.\n${renderBrief(activePlan)}`, {
          ...empty,
          plan: activePlan,
          resumed: true,
        });
      }
      if (!input.switchPlan) {
        return failResult(
          2,
          "active-plan-conflict",
          `Active plan ${activePlan.id} (${activePlan.status}) is unrelated to this request.`,
          { ...empty, plan: activePlan },
          "Resume it, pass --revise, or pass --switch to keep it on disk and start a new active plan.",
        );
      }
    }
  }

  const matched = matchingProjects(requirement, detection.projects);
  const questions = draftQuestions(requirement, classified.type, detection, matched);
  const plan = buildPlan({
    id: (input.createId ?? createPlanId)(now),
    now,
    identity,
    requirement,
    title: input.title?.trim() || titleFrom(requirement),
    changeType: classified.type,
    detection,
    matched,
    questions,
    answers: input.answers ?? {},
    acceptAssumptions: Boolean(input.acceptAssumptions),
    approve: Boolean(input.approve),
  });
  await captureBaseline(identity.root, plan);
  if (input.dryRun) {
    const code = plan.status === "needs-clarification" ? "needs-clarification" : "dry-run";
    const result = plan.status === "needs-clarification"
      ? failResult(2, code, renderBrief(plan), { ...empty, plan }, "Resolve blocking questions before approval.")
      : okResult(code, `Dry run: plan ${plan.id} was not written.\n${renderBrief(plan)}`, { ...empty, plan });
    return result;
  }
  await savePlan(identity.root, plan);
  await saveActivePointer(identity.root, pointerFor(plan, now));
  await appendJournal(identity.root, journal(now, "plan-created", `Created ${plan.id} with status ${plan.status}`, plan.id, null));
  if (plan.status === "needs-clarification") {
    return failResult(2, "needs-clarification", renderBrief(plan), { ...empty, plan }, "Answer blocking questions with --answer id=value, or pass --accept-assumptions.");
  }
  return okResult(plan.status, renderBrief(plan), { ...empty, plan });
}

function buildPlan(input: {
  id: string;
  now: Date;
  identity: RepositoryIdentity;
  requirement: string;
  title: string;
  changeType: ChangeType;
  detection: DetectionReport;
  matched: ProjectDetection[];
  questions: Plan["questions"];
  answers: Record<string, string>;
  acceptAssumptions: boolean;
  approve: boolean;
}): Plan {
  const stamp = input.now.toISOString();
  const projects = input.matched.length > 0 ? input.matched : input.detection.projects;
  const scopePaths = chooseScope(input.detection, input.matched, input.acceptAssumptions);
  const databases = [...new Set(projects.flatMap((project) => project.databases))];
  const commands = projects.flatMap((project) =>
    Object.entries(project.commands)
      .filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null)
      .map(([kind, command]) => `${project.root} ${kind}: ${command.command} ${command.args.join(" ")} (${command.source})`),
  );
  const affected = [
    ...projects.map((project) => project.root),
    ...projects.flatMap((project) => project.apiBoundaries),
    ...projects.flatMap((project) => project.manifests),
  ].slice(0, 20);
  const verify = primaryVerify(projects);
  const skills = skillsFor(input.detection.technologies);
  const plan: Plan = {
    schemaVersion: 1,
    id: input.id,
    repositoryId: input.identity.primary,
    repositoryPathId: input.identity.pathId,
    title: input.title,
    changeType: input.changeType,
    status: "draft",
    createdAt: stamp,
    updatedAt: stamp,
    requirements: input.requirement,
    problemStatement: problemStatement(input.changeType, input.requirement),
    scope: [
      input.requirement,
      scopePaths.length > 0 ? `Path scope: ${scopePaths.join(", ")}` : "Path scope is unresolved until the target package is chosen.",
    ],
    outOfScope: [
      "Unrelated refactors and drive-by cleanup.",
      "Dependency upgrades that the change does not require.",
      "Force-push, hook bypass, automatic merge, and destructive migrations.",
    ],
    scopePaths,
    architecture: {
      summary: architectureSummary(input.detection, skills),
      affectedComponents: affected.length > 0 ? affected : ["repository root"],
    },
    design: [
      "Follow the repository's existing module boundaries and dependency versions.",
      "Make the smallest change that satisfies the requirement and its acceptance criteria.",
      "Add or update automated tests for the changed behavior before calling the implementation task complete.",
      "The local planner does not invent an application design. The executing agent must inspect the affected components and record what changed in the task evidence.",
    ].join(" "),
    alternatives: [
      { name: "Minimal change", tradeoffs: "Lower review risk and easier rollback. This is the default." },
      { name: "Broader rewrite", tradeoffs: "Rejected unless a later revision records why the existing structure cannot meet the requirement." },
    ],
    tasks: buildTasks(input.changeType, input.requirement, scopePaths, verify),
    acceptanceCriteria: [
      input.requirement,
      "Automated tests cover the changed behavior, including at least one failure or boundary path when the change has one.",
      "Required quality gates recorded on the plan have a passing result, or an explicit exception is stored.",
      "No secrets, credentials, or unrelated user changes are included.",
    ],
    testStrategy: commands.length > 0 ? commands : ["No test command was detected. test-aidlc will report the gap instead of inventing a runner."],
    security: securityNotes(input.changeType),
    performance: [
      "Preserve existing timeouts, limits, and backpressure.",
      "Avoid unbounded loops, unbounded queries, and uncontrolled concurrency in the change.",
    ],
    database: databaseNotes(databases, input.requirement),
    observability: [
      "Keep the project's logging and metrics conventions.",
      "Do not log tokens, passwords, personal data, or raw confidential payloads.",
    ],
    rollback: [
      "Revert the feature branch or the specific commit.",
      "Do not rewrite published history.",
      "If a migration is introduced, review a reversible path before release and do not run a destructive migration without explicit approval.",
    ],
    documentation: [
      "Update user-facing docs and examples when behavior changes.",
      "Keep the plan's validation evidence current.",
    ],
    risks: [
      "This plan was produced by the local heuristic planner. It identifies scope and checks; it does not generate application code.",
      ...input.detection.warnings,
    ],
    assumptions: input.detection.assumptions.map((text, index) => ({
      id: `a${index + 1}`,
      text,
      blocking: false,
      resolved: false,
    })),
    questions: input.questions,
    approval: { status: "pending", at: null, note: null },
    validation: [],
    commits: [],
    revisions: [],
    exceptions: [],
    baseline: {
      branch: input.identity.branch,
      head: null,
      dirty: [],
      capturedAt: stamp,
    },
    authoring: {
      mode: "heuristic",
      note: "Local repository analysis. No model provider was called.",
    },
  };
  applyAnswers(plan, input.answers);
  if (input.acceptAssumptions) acceptBlocking(plan);
  refreshStatus(plan, input.approve);
  return plan;
}

async function captureBaseline(root: string, plan: Plan): Promise<void> {
  const snapshot = await createGitClient().snapshot(root);
  plan.baseline = {
    branch: snapshot.branch,
    head: snapshot.head,
    dirty: snapshot.files.map((file) => file.path),
    capturedAt: plan.baseline.capturedAt,
  };
}

function buildTasks(changeType: ChangeType, requirement: string, scopePaths: string[], verify: Task["verify"]): Task[] {
  const testTitle = changeType === "documentation" ? "Update examples and doc checks" : "Add or update automated tests";
  return [
    task("T1", "inspect", "Confirm affected components", "Read the architecture notes, manifests, and files in scope. Record anything the plan missed.", [], scopePaths, [
      "Affected components are confirmed or the plan is revised.",
    ], null),
    task("T2", "implement", "Implement the change", requirement, ["T1"], scopePaths, [
      "The smallest change that meets the requirement is in the worktree.",
      "Public behavior stays compatible unless the requirement authorizes a breaking change.",
    ], null),
    task("T3", "implement", testTitle, "Cover success, failure, and boundary behavior introduced by this change.", ["T2"], scopePaths, [
      "New or updated tests fail for the broken behavior and pass for the intended behavior.",
    ], null),
    task("T4", "verify", "Run validation", verify
      ? "Run the discovered validation command and record the real result."
      : "No validation command was discovered. Record that the check could not run.", ["T3"], scopePaths, [
      "The command result is stored as pass, fail, or not-run. A not-run result does not complete this task.",
    ], verify),
    task("T5", "review", "Review the diff and residual risk", "Inspect the diff for unrelated edits, secrets, and missing acceptance criteria.", ["T4"], scopePaths, [
      "The diff matches the plan scope and residual risks are recorded.",
    ], null),
  ];
}

function task(
  id: string,
  kind: Task["kind"],
  title: string,
  description: string,
  dependsOn: string[],
  paths: string[],
  acceptanceCriteria: string[],
  verify: Task["verify"],
): Task {
  return {
    id,
    title,
    description,
    kind,
    status: "pending",
    dependsOn,
    paths,
    acceptanceCriteria,
    verify,
    evidence: [],
    blockers: [],
  };
}

function draftQuestions(
  requirement: string,
  changeType: ChangeType,
  detection: DetectionReport,
  matched: ProjectDetection[],
): Plan["questions"] {
  const questions: Plan["questions"] = [];
  const words = requirement.split(/\s+/).filter(Boolean);
  if (words.length < 4) {
    questions.push({
      id: "q-behavior",
      prompt: "What user-visible behavior should change, and how will you recognize that it is done?",
      blocking: true,
      answer: null,
    });
  }
  if (changeType === "security" && !/\b(threat|vulnerab|attacker|auth|injection|xss|csrf|ssrf|cve|secret|permission|session)\b/i.test(requirement)) {
    questions.push({
      id: "q-security",
      prompt: "What threat should this change close, and what is the expected safe behavior?",
      blocking: true,
      answer: null,
    });
  }
  const databases = detection.projects.flatMap((project) => project.databases);
  if (/\b(migrat\w*|schema|alter table|database)\b/i.test(requirement) && databases.length === 0) {
    questions.push({
      id: "q-database",
      prompt: "Which database and migration tool should be used? None was detected.",
      blocking: true,
      answer: null,
    });
  }
  const packages = detection.projects.filter((project) => project.root !== ".");
  if (packages.length > 0 && matched.length === 0) {
    questions.push({
      id: "q-package",
      prompt: `Which package is in scope? Detected: ${packages.map((project) => `${project.name} (${project.root})`).join(", ")}.`,
      blocking: true,
      answer: null,
    });
  }
  return questions;
}

function applyAnswers(plan: Plan, answers: Record<string, string>): void {
  for (const question of plan.questions) {
    const answer = answers[question.id];
    if (answer && answer.trim().length > 0) {
      question.answer = answer.trim();
    }
  }
}

function acceptBlocking(plan: Plan): void {
  for (const question of plan.questions) {
    if (question.blocking && !question.answer) {
      question.answer = "[accepted assumption]";
      plan.assumptions.push({
        id: `a-${question.id}`,
        text: `Proceeding without an answer: ${question.prompt}`,
        blocking: false,
        resolved: false,
      });
      plan.risks.push(`Accepted unresolved question ${question.id}.`);
    }
  }
}

function unresolvedBlocking(plan: Plan): boolean {
  return plan.questions.some((question) => question.blocking && !question.answer);
}

function refreshStatus(plan: Plan, approve: boolean): void {
  if (unresolvedBlocking(plan)) {
    plan.status = "needs-clarification";
    plan.approval = { status: "pending", at: null, note: null };
    return;
  }
  if (approve) {
    plan.status = "approved";
    plan.approval = { status: "approved", at: plan.updatedAt, note: "Approved while creating the plan." };
    return;
  }
  plan.status = "awaiting-approval";
  plan.approval = { status: "pending", at: null, note: null };
}

function chooseScope(detection: DetectionReport, matched: ProjectDetection[], accepted: boolean): string[] {
  if (matched.length > 0) {
    return matched.map((project) => project.root);
  }
  const nested = detection.projects.filter((project) => project.root !== ".");
  if (nested.length === 0) {
    return ["."];
  }
  return accepted ? ["."] : [];
}

function matchingProjects(requirement: string, projects: ProjectDetection[]): ProjectDetection[] {
  const text = requirement.toLowerCase();
  return projects.filter((project) => project.root !== "." && (text.includes(project.root.toLowerCase()) || text.includes(project.name.toLowerCase())));
}

function primaryVerify(projects: ProjectDetection[]): Task["verify"] {
  for (const project of projects) {
    const command = project.commands.test;
    if (command) {
      return { command: command.command, args: command.args, cwd: command.cwd };
    }
  }
  return null;
}

function architectureSummary(detection: DetectionReport, skills: string[]): string {
  if (detection.technologies.length === 0) {
    return "No supported application stack was detected. Treat the repository as framework-agnostic and follow its local layout.";
  }
  const names = detection.technologies.map((technology) => `${technology.name} (${technology.confidence})`).join(", ");
  const layout = detection.monorepo ? "Monorepo boundaries were detected." : "Single-project layout.";
  return `${layout} Detected: ${names}. Applicable skills: ${skills.join(", ") || "shared lifecycle only"}.`;
}

function problemStatement(changeType: ChangeType, requirement: string): string {
  return `This ${changeType} request needs an explicit plan before application code changes: ${requirement}`;
}

function securityNotes(changeType: ChangeType): string[] {
  const notes = [
    "Do not hardcode credentials or write secrets into plans, logs, or commits.",
    "Validate untrusted input at the boundary this change touches.",
    "Do not disable authentication, authorization, or other security controls to obtain a passing check.",
  ];
  if (changeType === "security") {
    notes.push("Add a regression test that fails before the fix and passes after it.");
  }
  return notes;
}

function databaseNotes(databases: string[], requirement: string): string[] {
  if (databases.length === 0 && !/\b(migrat\w*|schema|database)\b/i.test(requirement)) {
    return ["No database or migration impact was identified."];
  }
  return [
    databases.length > 0 ? `Detected data tooling: ${databases.join(", ")}.` : "A database change was mentioned, but no migration tool was detected.",
    "Use the project's existing migration mechanism.",
    "Keep migrations reviewable and reversible where the tool allows it.",
    "Do not execute a destructive data change without explicit approval.",
  ];
}

function titleFrom(requirement: string): string {
  const compact = requirement.replace(/\s+/g, " ").trim();
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
}

function pointerFor(plan: Plan, now: Date) {
  return {
    schemaVersion: 1 as const,
    planId: plan.id,
    repositoryId: plan.repositoryId,
    repositoryPathId: plan.repositoryPathId,
    updatedAt: now.toISOString(),
  };
}

function journal(now: Date, type: string, message: string, planId: string | null, taskId: string | null) {
  return { at: now.toISOString(), type, message, planId, taskId };
}

async function loadRequestedPlan(root: string, planId?: string): Promise<Plan> {
  if (planId) {
    return loadPlan(root, planId);
  }
  const pointer = await loadActivePointer(root);
  if (!pointer) {
    throw new AidlcError("No active plan is selected.", {
      code: "not-found",
      recovery: "Create one with plan-aidlc, or select one with plan-aidlc --select <id>.",
    });
  }
  return loadPlan(root, pointer.planId);
}

function assertSameRepo(plan: Plan, identity: RepositoryIdentity): void {
  if (!sameRepository(plan, identity)) {
    throw new AidlcError(`Plan ${plan.id} belongs to a different repository.`, {
      code: "repository-mismatch",
      recovery: "Run the command from the repository that created the plan.",
    });
  }
}

async function summarizePlans(root: string): Promise<PlanData["plans"]> {
  const ids = await listPlanIds(root);
  const plans: PlanData["plans"] = [];
  for (const id of ids) {
    try {
      const plan = await loadPlan(root, id);
      plans.push({ id: plan.id, title: plan.title, status: plan.status, changeType: plan.changeType });
    } catch {
      plans.push({ id, title: "(unreadable)", status: "draft", changeType: "other" });
    }
  }
  return plans;
}

export function renderBrief(plan: Plan): string {
  const questions = plan.questions
    .filter((question) => question.blocking && !question.answer)
    .map((question) => `- ${question.id}: ${question.prompt}`)
    .join("\n");
  return [
    `${plan.id} [${plan.status}] ${plan.changeType}: ${plan.title}`,
    `Approval: ${plan.approval.status}`,
    questions ? `Blocking questions:\n${questions}` : "No blocking questions.",
    `Tasks: ${plan.tasks.map((task) => `${task.id}:${task.status}`).join(", ")}`,
    `JSON: ${AIDLC_PATHS.plansDir}/${plan.id}.json`,
  ].join("\n");
}
