import { z, type ZodError } from "zod";

export const SCHEMA_VERSION = 1 as const;

export const ChangeTypeSchema = z.enum([
  "feature",
  "bugfix",
  "refactor",
  "performance",
  "security",
  "documentation",
  "infrastructure",
  "other",
]);

export const PlanStatusSchema = z.enum([
  "draft",
  "needs-clarification",
  "awaiting-approval",
  "approved",
  "in-progress",
  "blocked",
  "completed",
  "cancelled",
]);

export const TaskStatusSchema = z.enum([
  "pending",
  "in-progress",
  "blocked",
  "completed",
  "skipped",
]);

export const CheckStatusSchema = z.enum(["pass", "fail", "not-run"]);

export const CheckKindSchema = z.enum([
  "format",
  "lint",
  "typecheck",
  "test",
  "integration",
  "e2e",
  "build",
  "security",
]);

export const ConfidenceSchema = z.enum(["high", "medium", "low"]);

export const TechnologyIdSchema = z.enum([
  "react",
  "angular",
  "nextjs",
  "nodejs",
  "express",
  "java",
  "spring-boot",
  "python",
  "fastapi",
  "flask",
  "django",
]);

export const EvidenceSchema = z
  .object({
    id: z.string().min(1),
    at: z.string().min(1),
    source: z.string().min(1),
    status: CheckStatusSchema,
    summary: z.string(),
    command: z.string().nullable(),
    head: z.string().nullable(),
    counts: z
      .object({
        passed: z.number().int().nonnegative().nullable(),
        failed: z.number().int().nonnegative().nullable(),
        skipped: z.number().int().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const VerifyCommandSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1),
  })
  .strict();

export const TaskSchema = z
  .object({
    id: z.string().regex(/^T[1-9][0-9]*$/),
    title: z.string().min(1),
    description: z.string(),
    kind: z.enum(["inspect", "implement", "verify", "review"]),
    status: TaskStatusSchema,
    dependsOn: z.array(z.string()),
    paths: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()),
    verify: VerifyCommandSchema.nullable(),
    evidence: z.array(EvidenceSchema),
    blockers: z.array(z.string()),
  })
  .strict();

export const PlanSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: z.string().regex(/^plan-[a-z0-9][a-z0-9-]{0,48}$/),
    repositoryId: z.string().min(1),
    repositoryPathId: z.string().min(1),
    title: z.string().min(1),
    changeType: ChangeTypeSchema,
    status: PlanStatusSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    requirements: z.string(),
    problemStatement: z.string(),
    scope: z.array(z.string()),
    outOfScope: z.array(z.string()),
    scopePaths: z.array(z.string()),
    architecture: z
      .object({
        summary: z.string(),
        affectedComponents: z.array(z.string()),
      })
      .strict(),
    design: z.string(),
    alternatives: z.array(
      z
        .object({
          name: z.string(),
          tradeoffs: z.string(),
        })
        .strict(),
    ),
    tasks: z.array(TaskSchema),
    acceptanceCriteria: z.array(z.string()),
    testStrategy: z.array(z.string()),
    security: z.array(z.string()),
    performance: z.array(z.string()),
    database: z.array(z.string()),
    observability: z.array(z.string()),
    rollback: z.array(z.string()),
    documentation: z.array(z.string()),
    risks: z.array(z.string()),
    assumptions: z.array(
      z
        .object({
          id: z.string(),
          text: z.string(),
          blocking: z.boolean(),
          resolved: z.boolean(),
        })
        .strict(),
    ),
    questions: z.array(
      z
        .object({
          id: z.string(),
          prompt: z.string(),
          blocking: z.boolean(),
          answer: z.string().nullable(),
        })
        .strict(),
    ),
    approval: z
      .object({
        status: z.enum(["pending", "approved", "rejected"]),
        at: z.string().nullable(),
        note: z.string().nullable(),
      })
      .strict(),
    validation: z.array(EvidenceSchema),
    commits: z.array(
      z
        .object({
          hash: z.string(),
          subject: z.string(),
          at: z.string(),
        })
        .strict(),
    ),
    revisions: z.array(
      z
        .object({
          at: z.string(),
          summary: z.string(),
        })
        .strict(),
    ),
    exceptions: z.array(
      z
        .object({
          at: z.string(),
          action: z.enum(["commit", "push"]),
          reason: z.string().min(1),
          gate: z.string(),
        })
        .strict(),
    ),
    baseline: z
      .object({
        branch: z.string().nullable(),
        head: z.string().nullable(),
        dirty: z.array(z.string()),
        capturedAt: z.string(),
      })
      .strict(),
    authoring: z
      .object({
        mode: z.enum(["heuristic", "imported"]),
        note: z.string(),
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const ids = new Set<string>();
    for (const task of plan.tasks) {
      if (ids.has(task.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate task id ${task.id}`, path: ["tasks"] });
      }
      ids.add(task.id);
    }
    for (const task of plan.tasks) {
      for (const dep of task.dependsOn) {
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${task.id} depends on unknown task ${dep}`,
            path: ["tasks"],
          });
        }
      }
    }
  });

export const CommandSpecSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string(),
    source: z.string(),
  })
  .strict();

export const ProjectCommandsSchema = z
  .object({
    format: CommandSpecSchema.nullable(),
    lint: CommandSpecSchema.nullable(),
    typecheck: CommandSpecSchema.nullable(),
    test: CommandSpecSchema.nullable(),
    integration: CommandSpecSchema.nullable(),
    e2e: CommandSpecSchema.nullable(),
    build: CommandSpecSchema.nullable(),
    security: CommandSpecSchema.nullable(),
  })
  .strict();

export const PolicySchema = z
  .object({
    fileChanges: z.enum(["allow", "prompt", "deny"]),
    shell: z.enum(["allow", "prompt", "deny"]),
    commit: z.enum(["allow", "prompt", "deny"]),
    network: z.enum(["allow", "prompt", "deny"]),
    pullRequest: z.enum(["allow", "prompt", "deny"]),
    allowDestructive: z.boolean(),
    allowFailedGateCommit: z.boolean(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    repositoryId: z.string().min(1),
    repositoryPathId: z.string().min(1),
    technologies: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          confidence: ConfidenceSchema,
          roots: z.array(z.string()),
        })
        .strict(),
    ),
    directories: z.array(z.string()),
    commands: z.record(z.string(), ProjectCommandsSchema),
    conventions: z
      .object({
        baseBranch: z.string().min(1),
        branchPattern: z.string().min(1),
        commitStyle: z.enum(["conventional", "none"]),
      })
      .strict(),
    qualityGates: z
      .object({
        required: z.array(CheckKindSchema),
        optional: z.array(CheckKindSchema),
      })
      .strict(),
    integrations: z
      .object({
        claude: z.boolean(),
        codex: z.boolean(),
        cursor: z.boolean(),
        vscode: z.boolean(),
        gitHost: z.enum(["github", "none"]),
      })
      .strict(),
    plans: z
      .object({
        directory: z.string().min(1),
        activePointer: z.string().min(1),
      })
      .strict(),
    policy: PolicySchema,
    ignore: z.array(z.string()),
  })
  .passthrough();

export const ActivePlanSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    planId: z.string().min(1),
    repositoryId: z.string().min(1),
    repositoryPathId: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export const JournalSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    events: z.array(
      z
        .object({
          at: z.string(),
          type: z.string(),
          message: z.string(),
          planId: z.string().nullable(),
          taskId: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const GeneratedManifestSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    files: z.record(
      z.string(),
      z
        .object({
          sha256: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export type ChangeType = z.infer<typeof ChangeTypeSchema>;
export type PlanStatus = z.infer<typeof PlanStatusSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type CheckStatus = z.infer<typeof CheckStatusSchema>;
export type CheckKind = z.infer<typeof CheckKindSchema>;
export type TechnologyId = z.infer<typeof TechnologyIdSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type CommandSpec = z.infer<typeof CommandSpecSchema>;
export type ProjectCommands = z.infer<typeof ProjectCommandsSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type AidlcConfig = z.infer<typeof ConfigSchema>;
export type ActivePlanPointer = z.infer<typeof ActivePlanSchema>;
export type Journal = z.infer<typeof JournalSchema>;
export type GeneratedManifest = z.infer<typeof GeneratedManifestSchema>;

export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export const TERMINAL_PLAN_STATUSES: readonly PlanStatus[] = ["completed", "cancelled"];

export function emptyCommands(): ProjectCommands {
  return {
    format: null,
    lint: null,
    typecheck: null,
    test: null,
    integration: null,
    e2e: null,
    build: null,
    security: null,
  };
}
