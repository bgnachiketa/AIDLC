import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hasHighConfidenceSecret, isSensitivePath, redact } from "../src/core/redact.js";
import { decidePolicy, defaultPolicy } from "../src/core/policy.js";
import { orderTasks } from "../src/core/tasks.js";
import { classifyChange } from "../src/core/planner.js";
import { parseCounts } from "../src/core/checks.js";
import { buildCommitArgs, buildPushArgs, buildStageArgs, parsePorcelain } from "../src/core/git.js";
import { conventionalSubject, groupCommitFiles, inScope, partitionChangeSet } from "../src/core/commit.js";
import { formatBranchName, safePushArgs } from "../src/core/publish.js";
import { PlanSchema } from "../src/core/schema.js";
import type { Plan, Task } from "../src/core/schema.js";

describe("redaction and secret paths", () => {
  it("redacts common credential shapes", () => {
    const input = [
      "key AKIAIOSFODNN7EXAMPLE",
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "Authorization: Bearer abcdefghijklmnop",
      "password=hunter22",
    ].join("\n");
    const output = redact(input);
    expect(output).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(output).not.toContain("abcdefghijklmnop");
    expect(output).not.toContain("hunter22");
    expect(hasHighConfidenceSecret(input)).toBe(true);
  });

  it("flags sensitive paths and allows examples", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath("config/.env.local")).toBe(true);
    expect(isSensitivePath(".env.example")).toBe(false);
    expect(isSensitivePath("secrets.json")).toBe(true);
    expect(isSensitivePath("src/App.tsx")).toBe(false);
  });
});

describe("policy", () => {
  it("does not let --yes override an explicit deny", async () => {
    const policy = { ...defaultPolicy(), shell: "deny" as const };
    const decision = await decidePolicy(policy, "shell", { yes: true, nonInteractive: true, tty: false }, "run");
    expect(decision.allowed).toBe(false);
  });

  it("treats --yes as approval only for prompts", async () => {
    const decision = await decidePolicy(defaultPolicy(), "commit", { yes: true, nonInteractive: true, tty: false }, "commit");
    expect(decision.allowed).toBe(true);
  });
});

describe("classification and tasks", () => {
  it("classifies security ahead of a generic fix", () => {
    expect(classifyChange("fix the xss in comments").type).toBe("security");
    expect(classifyChange("the save button is broken").type).toBe("bugfix");
    expect(classifyChange("add an invoice export").type).toBe("feature");
  });

  it("orders tasks and rejects cycles", () => {
    const tasks = [
      task("T2", ["T1"]),
      task("T1", []),
      task("T3", ["T2"]),
    ];
    expect(orderTasks(tasks).map((item) => item.id)).toEqual(["T1", "T2", "T3"]);
    expect(() => orderTasks([task("T1", ["T2"]), task("T2", ["T1"])])).toThrow(/cycle/i);
  });
});

describe("validation parsing", () => {
  it("parses vitest, pytest, and maven summaries", () => {
    expect(parseCounts("Tests  1 failed | 2 passed")).toMatchObject({ failed: 1, passed: 2 });
    expect(parseCounts("3 passed, 1 failed")).toMatchObject({ passed: 3, failed: 1 });
    expect(parseCounts("Tests run: 4, Failures: 1, Errors: 0, Skipped: 1")).toMatchObject({ passed: 2, failed: 1, skipped: 1 });
  });
});

describe("git safety helpers", () => {
  it("refuses wildcard staging and force pushes", () => {
    expect(() => buildStageArgs(["."])).toThrow(/wildcard|option/i);
    expect(buildStageArgs(["src/app.ts"])).toEqual(["add", "--", "src/app.ts"]);
    expect(buildCommitArgs("feat: add export", "Plan: plan-1", false)).not.toContain("--amend");
    expect(buildCommitArgs("feat: add export", "Plan: plan-1", false)).not.toContain("--no-verify");
    expect(() => buildPushArgs("origin", "main")).toThrow(/main/);
    expect(safePushArgs("origin", "feat/plan-1")).toEqual(["push", "-u", "origin", "feat/plan-1:feat/plan-1"]);
    expect(safePushArgs("origin", "feat/plan-1").join(" ")).not.toContain("force");
  });

  it("parses a rename record from porcelain v1 -z", () => {
    const raw = "R  new.txt\0old.txt\0?? untracked.txt\0";
    const parsed = parsePorcelain(raw);
    expect(parsed.map((file) => file.path)).toContain("new.txt");
    expect(parsed.find((file) => file.path === "new.txt")?.origPath).toBe("old.txt");
    expect(parsed.find((file) => file.untracked)?.path).toBe("untracked.txt");
  });
});

describe("commit selection", () => {
  it("drops secrets, generated files, and pre-existing dirty paths", () => {
    const result = partitionChangeSet(
      ["src/app.ts", ".env", "dist/index.js", "notes.md"],
      ["."],
      ["notes.md"],
      [],
    );
    expect(result.related).toEqual(["src/app.ts"]);
    expect(result.secrets).toContain(".env");
    expect(result.generated).toContain("dist/index.js");
    expect(result.unrelated).toContain("notes.md");
    expect(inScope("services/api/src/index.ts", ["services/api"])).toBe(true);
    expect(inScope("apps/web/page.tsx", ["services/api"])).toBe(false);
  });

  it("builds a conventional subject and can split tests", () => {
    expect(conventionalSubject("feature", "api", "add request validation").startsWith("feat(api): ")).toBe(true);
    const groups = groupCommitFiles(["src/app.ts", "src/app.test.ts"], "feature", "add export", "plan-20261025-abc123", true);
    expect(groups.map((group) => group.files[0])).toEqual(["src/app.ts", "src/app.test.ts"]);
    expect(groups[1]?.subject.startsWith("test")).toBe(true);
  });
});

describe("pull request naming", () => {
  it("formats a feature branch from the plan", () => {
    const plan = minimalPlan();
    expect(formatBranchName("{type}/{planId}-{slug}", plan)).toBe("feat/plan-20261025-sample-add-invoice-export");
  });

  it("accepts the checked-in sample plan", () => {
    const sample = JSON.parse(readFileSync(new URL("../../../examples/sample-plan.json", import.meta.url), "utf8"));
    expect(PlanSchema.parse(sample).id).toBe("plan-20261025-sample");
  });
});

function task(id: string, dependsOn: string[]): Task {
  return {
    id,
    title: id,
    description: id,
    kind: "implement",
    status: "pending",
    dependsOn,
    paths: ["."],
    acceptanceCriteria: ["done"],
    verify: null,
    evidence: [],
    blockers: [],
  };
}

function minimalPlan(): Plan {
  const plan = {
    schemaVersion: 1 as const,
    id: "plan-20261025-sample",
    repositoryId: "path:abc",
    repositoryPathId: "path:abc",
    title: "Add invoice export",
    changeType: "feature" as const,
    status: "approved" as const,
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
    requirements: "Add a CSV export for paid invoices.",
    problemStatement: "Users cannot export invoices.",
    scope: ["export"],
    outOfScope: ["billing"],
    scopePaths: ["."],
    architecture: { summary: "Existing service.", affectedComponents: ["src"] },
    design: "Add a narrow export function.",
    alternatives: [{ name: "Minimal change", tradeoffs: "Easier rollback." }],
    tasks: [task("T1", [])],
    acceptanceCriteria: ["CSV downloads"],
    testStrategy: ["unit"],
    security: ["No secrets"],
    performance: ["Stream rows"],
    database: ["No database change was identified."],
    observability: ["Do not log payloads"],
    rollback: ["Revert the commit"],
    documentation: ["Update the README"],
    risks: ["Heuristic plan"],
    assumptions: [],
    questions: [],
    approval: { status: "approved" as const, at: "2026-10-25T00:00:00.000Z", note: "test" },
    validation: [],
    commits: [],
    revisions: [],
    exceptions: [],
    baseline: { branch: "main", head: null, dirty: [], capturedAt: "2026-10-25T00:00:00.000Z" },
    authoring: { mode: "heuristic" as const, note: "test" },
  };
  return PlanSchema.parse(plan);
}
