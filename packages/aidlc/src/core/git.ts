import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { AidlcError } from "./errors.js";
import { assertInside, readText } from "./fsutil.js";
import { defaultRunner, type CommandResult, type ProcessRunner } from "./process.js";
import { isSensitivePath } from "./redact.js";

export interface GitFileChange {
  index: string;
  worktree: string;
  path: string;
  origPath: string | null;
  untracked: boolean;
}

export interface GitSnapshot {
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  files: GitFileChange[];
}

export interface GitClient {
  snapshot(root: string): Promise<GitSnapshot>;
  checkoutNewBranch(root: string, branch: string): Promise<void>;
  push(root: string, remote: string, branch: string): Promise<CommandResult>;
  remoteUrl(root: string, remote: string): Promise<string | null>;
  divergence(root: string, base: string, head: string): Promise<{ ahead: number; behind: number } | null>;
  stage(root: string, files: string[]): Promise<void>;
  commit(root: string, subject: string, body: string, amend: boolean): Promise<CommandResult>;
  head(root: string): Promise<string | null>;
  readFile(root: string, relativePath: string): Promise<string | null>;
}

export function parsePorcelain(raw: string): GitFileChange[] {
  if (!raw) {
    return [];
  }
  const records = raw.split("\0");
  const changes: GitFileChange[] = [];
  let index = 0;
  while (index < records.length) {
    const record = records[index];
    if (!record) {
      index += 1;
      continue;
    }
    if (record.length < 3) {
      break;
    }
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    const renamed = status.includes("R") || status.includes("C");
    let origPath: string | null = null;
    if (renamed) {
      origPath = records[index + 1] ?? null;
      index += 2;
    } else {
      index += 1;
    }
    changes.push({
      index: status[0] ?? " ",
      worktree: status[1] ?? " ",
      path: renamed ? filePath : filePath,
      origPath,
      untracked: status === "??",
    });
  }
  return changes.filter((change) => change.path.length > 0);
}

export function buildStageArgs(files: string[]): string[] {
  if (files.length === 0) {
    throw new AidlcError("Refusing to stage an empty path list", {
      code: "git-safety",
      recovery: "Select explicit files. AIDLC never stages the whole worktree.",
    });
  }
  if (files.some((file) => file === "." || file === "-A" || file === "--all" || file.startsWith("-"))) {
    throw new AidlcError("Refusing to stage a wildcard or option", {
      code: "git-safety",
      recovery: "Pass repository-relative file paths.",
    });
  }
  return ["add", "--", ...files];
}

export function buildCommitArgs(subject: string, body: string, amend: boolean): string[] {
  const args = ["commit", "-m", subject];
  if (body.trim().length > 0) {
    args.push("-m", body);
  }
  if (amend) {
    args.push("--amend");
  }
  return args;
}

export function buildPushArgs(remote: string, branch: string): string[] {
  if (branch === "main" || branch === "master") {
    throw new AidlcError(`Refusing to push ${branch} as a feature branch`, {
      code: "git-safety",
      recovery: "Create a short-lived branch before publishing.",
    });
  }
  return ["push", "-u", remote, `${branch}:${branch}`];
}

export function assertPushArgsSafe(args: string[]): void {
  const blocked = new Set(["--force", "--force-with-lease", "-f", "--no-verify", "--mirror"]);
  for (const arg of args) {
    if (blocked.has(arg)) {
      throw new AidlcError(`Refusing unsafe git argument ${arg}`, {
        code: "git-safety",
        recovery: "AIDLC does not force-push, mirror, or skip hooks.",
      });
    }
  }
}

export function createGitClient(runner: ProcessRunner = defaultRunner): GitClient {
  return {
    async snapshot(root) {
      const top = await runner.run("git", ["rev-parse", "--show-toplevel"], root, { timeoutMs: 15_000 });
      if (top.code !== 0) {
        return { isRepo: false, branch: null, detached: false, head: null, upstream: null, files: [] };
      }
      const branch = await runner.run("git", ["branch", "--show-current"], root, { timeoutMs: 15_000 });
      const head = await runner.run("git", ["rev-parse", "HEAD"], root, { timeoutMs: 15_000 });
      const status = await runner.run("git", ["status", "--porcelain=v1", "-z", "-uall"], root, { timeoutMs: 20_000 });
      const upstream = await runner.run(
        "git",
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        root,
        { timeoutMs: 15_000 },
      );
      const branchName = branch.code === 0 ? branch.stdout.trim() : "";
      return {
        isRepo: true,
        branch: branchName.length > 0 ? branchName : null,
        detached: branch.code === 0 && branchName.length === 0,
        head: head.code === 0 ? head.stdout.trim() : null,
        upstream: upstream.code === 0 ? upstream.stdout.trim() : null,
        files: status.code === 0 ? parsePorcelain(status.stdout) : [],
      };
    },
    async checkoutNewBranch(root, branch) {
      const result = await runner.run("git", ["checkout", "-b", branch], root, { timeoutMs: 20_000 });
      if (result.code !== 0) {
        throw new AidlcError(result.stderr.trim() || `Could not create branch ${branch}`, {
          code: "git-failed",
          recovery: "Choose a branch name that does not already exist and retry.",
        });
      }
    },
    async push(root, remote, branch) {
      const args = buildPushArgs(remote, branch);
      assertPushArgsSafe(args);
      return runner.run("git", args, root, { timeoutMs: 120_000 });
    },
    async remoteUrl(root, remote) {
      const result = await runner.run("git", ["remote", "get-url", remote], root, { timeoutMs: 15_000 });
      if (result.code !== 0) {
        return null;
      }
      const value = result.stdout.trim();
      return value.length > 0 ? value : null;
    },
    async divergence(root, base, head) {
      const result = await runner.run(
        "git",
        ["rev-list", "--left-right", "--count", `${base}...${head}`],
        root,
        { timeoutMs: 20_000 },
      );
      if (result.code !== 0) {
        return null;
      }
      const [behindRaw, aheadRaw] = result.stdout.trim().split(/\s+/);
      const behind = Number(behindRaw);
      const ahead = Number(aheadRaw);
      if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
        return null;
      }
      return { ahead, behind };
    },
    async stage(root, files) {
      for (const file of files) {
        assertInside(root, file);
        if (isSensitivePath(file)) {
          throw new AidlcError(`Refusing to stage sensitive path ${file}`, {
            code: "secret-detected",
            recovery: "Remove the secret from the change set. AIDLC will not stage it.",
          });
        }
      }
      const args = buildStageArgs(files);
      const result = await runner.run("git", args, root, { timeoutMs: 30_000 });
      if (result.code !== 0) {
        throw new AidlcError(result.stderr.trim() || "git add failed", { code: "git-failed" });
      }
    },
    async commit(root, subject, body, amend) {
      const args = buildCommitArgs(subject, body, amend);
      assertPushArgsSafe(args);
      return runner.run("git", args, root, { timeoutMs: 60_000 });
    },
    async head(root) {
      const result = await runner.run("git", ["rev-parse", "HEAD"], root, { timeoutMs: 15_000 });
      return result.code === 0 ? result.stdout.trim() : null;
    },
    async readFile(root, relativePath) {
      const absolute = assertInside(root, relativePath);
      try {
        const info = await stat(absolute);
        if (!info.isFile() || info.size > 1_000_000) {
          return null;
        }
      } catch {
        return null;
      }
      return readText(absolute);
    },
  };
}

export async function readWorkingFile(root: string, relativePath: string): Promise<string | null> {
  const absolute = path.join(root, relativePath);
  try {
    return await readFile(absolute, "utf8");
  } catch {
    return null;
  }
}
