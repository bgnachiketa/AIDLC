import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { executePlan } from "../src/core/execute.js";
import { initializeRepository } from "../src/core/initialize.js";
import { loadPlan } from "../src/core/plan-store.js";
import { planChange } from "../src/core/planner.js";
import { runValidation } from "../src/core/checks.js";
import { commitChanges } from "../src/core/commit.js";
import { publishPlan, type GitHostAdapter } from "../src/core/publish.js";
import { type GitClient, type GitSnapshot } from "../src/core/git.js";
import { repairState } from "../src/core/state.js";
import { main } from "../src/cli/main.js";
import { HOST_COMMANDS } from "../src/hosts/catalog.js";
import { captureOutput, copyFixture, gitRepo, removeTemp, tempDir } from "./helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => removeTemp(directory)));
});

const approved = {
  yes: true,
  nonInteractive: true,
  tty: false,
};

describe("initialization", () => {
  it("is idempotent, preserves user instructions, and supports dry-run", async () => {
    const directory = await copyFixture("react");
    directories.push(directory);
    await writeFile(path.join(directory, "AGENTS.md"), "# User rules\nDo not replace this.\n");
    await writeFile(path.join(directory, "README.md"), "# Existing product\n");
    const dry = await initializeRepository({ cwd: directory, dryRun: true, ...approved });
    expect(dry.ok).toBe(true);
    await expect(readFile(path.join(directory, ".aidlc", "config.yaml"))).rejects.toThrow();
    const first = await initializeRepository({ cwd: directory, ...approved });
    expect(first.ok).toBe(true);
    expect(await readFile(path.join(directory, "AGENTS.md"), "utf8")).toBe("# User rules\nDo not replace this.\n");
    expect(await readFile(path.join(directory, "README.md"), "utf8")).toBe("# Existing product\n");
    expect(await readFile(path.join(directory, ".aidlc", "proposed", "AGENTS.md"), "utf8")).toMatch(/Agent instructions/);
    await expect(readFile(path.join(directory, ".claude", "skills", "aidlc-django", "SKILL.md"))).rejects.toThrow();
    expect(await readFile(path.join(directory, ".claude", "skills", "aidlc-react", "SKILL.md"), "utf8")).toMatch(/name: aidlc-react/);
    expect(await readFile(path.join(directory, ".agents", "skills", "plan-aidlc", "SKILL.md"), "utf8")).toMatch(/plan-aidlc/);
    const initSkill = await readFile(path.join(directory, ".cursor", "skills", "init-aidlc", "SKILL.md"), "utf8");
    expect(initSkill).toMatch(/name: init-aidlc/);
    expect(initSkill).toMatch(/disable-model-invocation: true/);
    expect(initSkill).toMatch(/no npm dependency/);
    expect(initSkill).toMatch(/\/aidlc:init-aidlc/);
    expect(initSkill).not.toMatch(/npm install/);
    const pluginRoot = fileURLToPath(new URL("../../../plugins/aidlc", import.meta.url));
    const pluginSkill = await readFile(path.join(pluginRoot, "skills", "init-aidlc", "SKILL.md"), "utf8");
    expect(pluginSkill).toBe(initSkill);
    expect(JSON.parse(await readFile(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).name).toBe("aidlc");
    expect(JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")).skills).toBe("./skills/");
    expect(pluginSkill).not.toMatch(/npm install/);
    expect(await readFile(path.join(directory, ".cursor", "rules", "aidlc-lifecycle.mdc"), "utf8")).toMatch(/alwaysApply: true/);
    const workflow = await readFile(path.join(directory, ".aidlc", "proposed", "github", "workflows", "aidlc-ci.yml"), "utf8");
    expect(workflow).toContain("11d5960a326750d5838078e36cf38b85af677262");
    await expect(readFile(path.join(directory, ".github", "workflows", "aidlc-ci.yml"))).rejects.toThrow();
    const second = await initializeRepository({ cwd: directory, ...approved });
    expect(second.data.changes.some((change) => change.action === "create" || change.action === "update" || change.action === "propose")).toBe(false);
  });

  it("does not write when file changes are denied", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const result = await initializeRepository({ cwd: directory, yes: false, nonInteractive: true, tty: false });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("policy-denied");
    await expect(readFile(path.join(directory, "AGENTS.md"))).rejects.toThrow();
  });
});

describe("plans and execution", () => {
  it("blocks approval on missing behavior, resumes an equivalent plan, and refuses to replace another", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const vague = await planChange({ cwd: directory, requirement: "fix bug", createId: () => "plan-20261025-vague1" });
    expect(vague.code).toBe("needs-clarification");
    expect(vague.data.plan?.status).toBe("needs-clarification");
    const approvedPlan = await planChange({ cwd: directory, planId: vague.data.plan?.id, approve: true });
    expect(approvedPlan.ok).toBe(false);
    const requirement = "Add a CSV export for paid invoices in the billing screen";
    const created = await planChange({ cwd: directory, requirement, title: "Invoice export", createId: () => "plan-20261025-export", switchPlan: true });
    expect(created.data.plan?.status).toBe("awaiting-approval");
    const resumed = await planChange({ cwd: directory, requirement, title: "Invoice export", createId: () => "plan-20261025-other1" });
    expect(resumed.code).toBe("resumed");
    expect(resumed.data.plan?.id).toBe("plan-20261025-export");
    const conflict = await planChange({ cwd: directory, requirement: "Add a completely different audit log for administrators", createId: () => "plan-20261025-audit1" });
    expect(conflict.code).toBe("active-plan-conflict");
    const execution = await executePlan({ cwd: directory, ...approved });
    expect(execution.code).toBe("not-approved");
  });

  it("resumes the approved plan and does not repeat a completed task", async () => {
    const directory = await tempDir();
    directories.push(directory);
    const requirement = "Add a CSV export for paid invoices in the billing screen";
    await planChange({ cwd: directory, requirement, approve: true, createId: () => "plan-20261025-export" });
    const first = await executePlan({ cwd: directory, ...approved });
    expect(first.ok).toBe(true);
    expect(first.data.plan?.tasks.find((task) => task.id === "T1")?.status).toBe("completed");
    expect(first.data.packet?.taskId).toBe("T2");
    const denied = await executePlan({ cwd: directory, action: "complete", taskId: "T2", ...approved });
    expect(denied.code).toBe("needs-evidence");
    const completed = await executePlan({
      cwd: directory,
      action: "complete",
      taskId: "T2",
      evidence: "Added the export endpoint and a failing-then-passing test.",
      ...approved,
    });
    expect(completed.data.plan?.tasks.find((task) => task.id === "T2")?.status).toBe("completed");
    const again = await executePlan({ cwd: directory, action: "complete", taskId: "T2", evidence: "Added the export endpoint and a failing-then-passing test.", ...approved });
    expect(again.code).toBe("unchanged");
    const early = await executePlan({ cwd: directory, action: "complete", taskId: "T4", evidence: "Tried to skip ahead.", ...approved });
    expect(early.ok).toBe(false);
  });

  it("refuses an unsupported or corrupt plan without deleting it until repair", async () => {
    const directory = await tempDir();
    directories.push(directory);
    await planChange({ cwd: directory, requirement: "Add a CSV export for paid invoices in the billing screen", createId: () => "plan-20261025-export" });
    const file = path.join(directory, ".aidlc", "plans", "plan-20261025-export.json");
    const original = await readFile(file, "utf8");
    const unsupported = original.replace('"schemaVersion": 1', '"schemaVersion": 2');
    await writeFile(file, unsupported);
    await expect(loadPlan(directory, "plan-20261025-export")).rejects.toThrow(/schemaVersion/);
    expect(await readFile(file, "utf8")).toContain('"schemaVersion": 2');
    await writeFile(file, "{");
    await expect(loadPlan(directory, "plan-20261025-export")).rejects.toThrow(/JSON/);
    expect(await readFile(file, "utf8")).toBe("{");
    const notes = await repairState(directory);
    expect(notes.join(" ")).toMatch(/Quarantined/);
    await expect(readFile(file)).rejects.toThrow();
  });
});

describe("validation and git safety", () => {
  it("reports a real failing command and does not call it a pass", async () => {
    const directory = await tempDir();
    directories.push(directory);
    await writeFile(path.join(directory, "package.json"), JSON.stringify({
      name: "sample",
      scripts: { test: "node -e \"console.log('AKIAIOSFODNN7EXAMPLE'); process.exit(1)\"" },
    }));
    await planChange({ cwd: directory, requirement: "Add a CSV export for paid invoices in the billing screen", approve: true, createId: () => "plan-20261025-export" });
    const result = await runValidation({ cwd: directory, ...approved });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("quality-gate-failed");
    expect(result.data.checks[0]?.status).toBe("fail");
    expect(JSON.stringify(result.data)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    const plan = await loadPlan(directory, "plan-20261025-export");
    expect(plan.validation[0]?.summary).not.toContain("AKIA");
  });

  it("leaves secrets and pre-existing edits unstaged", async () => {
    const directory = await gitRepo();
    directories.push(directory);
    await writeFile(path.join(directory, "notes.md"), "before\n");
    const { runProcess } = await import("../src/core/process.js");
    await runProcess("git", ["add", "--", "notes.md"], directory, { timeoutMs: 20_000 });
    await runProcess("git", ["commit", "-m", "notes"], directory, { timeoutMs: 20_000 });
    await writeFile(path.join(directory, "notes.md"), "pre-existing\n");
    await planChange({ cwd: directory, requirement: "Add a CSV export for paid invoices in the billing screen", approve: true, createId: () => "plan-20261025-export" });
    await writeFile(path.join(directory, "src.txt"), "export\n");
    await writeFile(path.join(directory, ".env"), "TOKEN=secret\n");
    await writeFile(path.join(directory, "src-key.ts"), "export const key = 'AKIAIOSFODNN7EXAMPLE';\n");
    const plan = await loadPlan(directory, "plan-20261025-export");
    plan.validation.push({
      id: "ev-test",
      at: new Date().toISOString(),
      source: "test:.",
      status: "pass",
      summary: "1 passed",
      command: "npm test",
      head: null,
      counts: { passed: 1, failed: 0, skipped: null },
    });
    const { savePlan } = await import("../src/core/plan-store.js");
    await savePlan(directory, plan);
    const committed = await commitChanges({ cwd: directory, acceptStale: true, ...approved });
    expect(committed.ok).toBe(true);
    const status = await runProcess("git", ["status", "--porcelain=v1", "-z"], directory, { timeoutMs: 20_000 });
    expect(status.stdout).toContain("notes.md");
    expect(status.stdout).toContain(".env");
    expect(status.stdout).toContain("src-key.ts");
    expect(status.stdout).not.toContain("src.txt");
    const log = await runProcess("git", ["log", "-1", "--format=%B"], directory, { timeoutMs: 20_000 });
    expect(log.stdout).toMatch(/feat/);
    expect(log.stdout).toContain("plan-20261025-export");
    expect(log.stdout).not.toContain("--amend");
  });
});

describe("publishing", () => {
  it("prepares a pull request without calling the host on dry-run and without force", async () => {
    const directory = await gitRepo();
    directories.push(directory);
    await planChange({ cwd: directory, requirement: "Add a CSV export for paid invoices in the billing screen", approve: true, createId: () => "plan-20261025-export" });
    const plan = await loadPlan(directory, "plan-20261025-export");
    for (const task of plan.tasks) task.status = "completed";
    plan.status = "completed";
    plan.validation.push({
      id: "ev-test",
      at: new Date().toISOString(),
      source: "test:.",
      status: "pass",
      summary: "passed",
      command: "npm test",
      head: "abc123",
      counts: null,
    });
    const { savePlan } = await import("../src/core/plan-store.js");
    await savePlan(directory, plan);
    const pushes: string[][] = [];
    const git = fakeGit(pushes);
    const host: GitHostAdapter = {
      id: "github",
      async available() { return { ok: true }; },
      async findPullRequest() { return null; },
      async upsertPullRequest() { throw new Error("should not create during dry-run"); },
    };
    const preview = await publishPlan({ cwd: directory, dryRun: true, git, host, acceptStale: true, ...approved });
    expect(preview.ok).toBe(true);
    expect(preview.data.draft?.body).toContain("plan-20261025-export");
    expect(preview.data.draft?.body).toMatch(/Security considerations/);
    expect(pushes).toEqual([]);
    const published = await publishPlan({
      cwd: directory,
      git,
      host: {
        id: "github",
        async available() { return { ok: false, reason: "GitHub CLI (gh) is not installed." }; },
        async findPullRequest() { return null; },
        async upsertPullRequest(input) { return { url: `https://example.test/${input.head}`, number: 1, created: true }; },
      },
      acceptStale: true,
      ...approved,
    });
    expect(published.code).toBe("host-unavailable");
    expect(published.data.created).toBe(false);
    expect(published.data.url).toBeNull();
    expect(pushes.some((args) => args.includes("--force"))).toBe(false);
  });
});

describe("command walkthrough", () => {
  it("runs each lifecycle command and records the real result", async () => {
    const directory = await gitRepo();
    directories.push(directory);
    const run = (args: string[]) => captureOutput(() => main(["node", "aidlc", "--cwd", directory, "--yes", "--non-interactive", ...args]));

    const help = await run(["help-aidlc"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("archive-aidlc");
    expect(help.stdout).toContain("audit-aidlc");

    const init = await run(["init-aidlc"]);
    expect(init.code).toBe(0);
    expect(init.stdout).toMatch(/created|unchanged|updated/i);

    const plan = await run(["plan-aidlc", "--title", "Invoice export", "--type", "feature", "--approve", "Add a CSV export for paid invoices in the billing screen"]);
    expect(plan.code).toBe(0);
    expect(plan.stdout).toMatch(/plan-/);

    const execute = await run(["execute-aidlc"]);
    expect(execute.code).toBe(0);
    expect(execute.stdout.length).toBeGreaterThan(0);

    const validation = await run(["test-aidlc"]);
    expect(validation.code).not.toBe(0);
    expect(`${validation.stdout}${validation.stderr}`).toMatch(/not-run|missing|FAIL|failed/i);

    const commit = await run(["commit-aidlc", "--dry-run"]);
    expect(commit.code).toBe(3);
    expect(`${commit.stdout}${commit.stderr}`).toMatch(/quality gate|failed|not-run/i);

    const publish = await run(["push-aidlc", "--dry-run", "--allow-incomplete"]);
    expect([0, 2]).toContain(publish.code);
    expect(`${publish.stdout}${publish.stderr}`.length).toBeGreaterThan(0);

    const audit = await run(["audit-aidlc"]);
    expect(audit.code).toBe(0);
    const changelog = await readFile(path.join(directory, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("Invoice export");
    expect(changelog).toContain("<!-- aidlc:audit -->");

    const archived = await run(["archive-aidlc"]);
    expect(archived.code).toBe(0);
    expect(archived.stdout).toContain(".github/aidlc/archive/");
    const planId = archived.stdout.match(/plan-[a-z0-9-]+/)?.[0];
    expect(planId).toBeTruthy();
    await expect(readFile(path.join(directory, ".aidlc", "plans", `${planId}.json`))).rejects.toThrow();
    const stored = await readFile(path.join(directory, ".github", "aidlc", "archive", `${planId}.json`), "utf8");
    expect(stored).toContain("Invoice export");

    const secondAudit = await run(["audit-aidlc"]);
    expect(secondAudit.code).toBe(0);
    const updated = await readFile(path.join(directory, "CHANGELOG.md"), "utf8");
    expect(updated).toContain("Archived plans");
    expect(updated.match(/<!-- aidlc:audit -->/g)).toHaveLength(1);
  });
});

describe("cli", () => {
  it("shows every canonical command and rejects an unknown change type", async () => {
    const help = await captureOutput(() => main(["node", "aidlc", "help-aidlc"]));
    expect(help.code).toBe(0);
    for (const command of HOST_COMMANDS) {
      expect(help.stdout).toContain(command.canonical);
    }
    const bad = await captureOutput(() => main(["node", "aidlc", "plan-aidlc", "--type", "nope", "Add a valid requirement here"]));
    expect(bad.code).not.toBe(0);
    expect(`${bad.stderr}${bad.stdout}`).toMatch(/change type/i);
  });
});

function fakeGit(pushes: string[][]): GitClient {
  const snapshot: GitSnapshot = {
    isRepo: true,
    branch: "main",
    detached: false,
    head: "abc123",
    upstream: "origin/main",
    files: [],
  };
  return {
    async snapshot() { return snapshot; },
    async checkoutNewBranch(_root, branch) { snapshot.branch = branch; },
    async push(_root, remote, branch) {
      const args = ["push", "-u", remote, `${branch}:${branch}`];
      pushes.push(args);
      return { command: "git", args, cwd: _root, code: 0, signal: null, stdout: "", stderr: "", timedOut: false, durationMs: 1, cancelled: false };
    },
    async remoteUrl() { return "https://example.test/repo.git"; },
    async divergence() { return { ahead: 0, behind: 0 }; },
    async stage() { throw new Error("not used"); },
    async commit() { throw new Error("not used"); },
    async head() { return snapshot.head; },
    async readFile() { return null; },
  };
}
