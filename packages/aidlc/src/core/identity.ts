import { realpath } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./fsutil.js";
import { defaultRunner, type ProcessRunner } from "./process.js";

export interface RepositoryIdentity {
  root: string;
  gitRoot: string | null;
  pathId: string;
  remoteId: string | null;
  primary: string;
  remote: string | null;
  branch: string | null;
  detached: boolean;
}

export function normalizeRemote(url: string): string {
  return url.trim().replace(/\.git$/i, "");
}

export async function resolveRepository(
  cwd: string,
  runner: ProcessRunner = defaultRunner,
): Promise<RepositoryIdentity> {
  const start = path.resolve(cwd);
  const gitRoot = await findGitRoot(start, runner);
  const root = gitRoot ?? start;
  const real = await realpath(root).catch(() => root);
  const pathId = `path:${sha256(real).slice(0, 16)}`;
  const remote = gitRoot ? await readRemote(root, runner) : null;
  const remoteId = remote ? `git:${normalizeRemote(remote)}` : null;
  const branchInfo = gitRoot ? await readBranch(root, runner) : { branch: null, detached: false };
  return {
    root,
    gitRoot,
    pathId,
    remoteId,
    primary: remoteId ?? pathId,
    remote,
    branch: branchInfo.branch,
    detached: branchInfo.detached,
  };
}

export function sameRepository(
  stored: { repositoryId: string; repositoryPathId: string },
  current: RepositoryIdentity,
): boolean {
  return (
    stored.repositoryPathId === current.pathId ||
    stored.repositoryId === current.primary ||
    (current.remoteId !== null && stored.repositoryId === current.remoteId) ||
    stored.repositoryId === current.pathId
  );
}

async function findGitRoot(cwd: string, runner: ProcessRunner): Promise<string | null> {
  const result = await runner.run("git", ["rev-parse", "--show-toplevel"], cwd, { timeoutMs: 15_000 }).catch(() => null);
  if (!result || result.code !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

async function readRemote(root: string, runner: ProcessRunner): Promise<string | null> {
  const result = await runner.run("git", ["remote", "get-url", "origin"], root, { timeoutMs: 15_000 }).catch(() => null);
  if (!result || result.code !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

async function readBranch(
  root: string,
  runner: ProcessRunner,
): Promise<{ branch: string | null; detached: boolean }> {
  const result = await runner.run("git", ["branch", "--show-current"], root, { timeoutMs: 15_000 }).catch(() => null);
  if (!result || result.code !== 0) {
    return { branch: null, detached: false };
  }
  const branch = result.stdout.trim();
  if (!branch) {
    return { branch: null, detached: true };
  }
  return { branch, detached: false };
}
