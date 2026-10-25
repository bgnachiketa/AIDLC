import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AidlcError } from "./errors.js";

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function randomId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readText(target: string): Promise<string | null> {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

export async function writeAtomic(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, target);
}

export function assertInside(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new AidlcError(`Refusing absolute path ${relativePath}`, {
      code: "path-escape",
      recovery: "Use a path relative to the repository root.",
    });
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === "" ) {
    return resolvedRoot;
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AidlcError(`Path escapes the repository: ${relativePath}`, {
      code: "path-escape",
      recovery: "Choose a path inside the repository.",
    });
  }
  return resolved;
}

export function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export async function readJson(target: string): Promise<unknown> {
  const text = await readText(target);
  if (text === null) {
    throw new AidlcError(`File not found: ${target}`, {
      code: "not-found",
      recovery: "Create the file with the matching AIDLC command or restore it from version control.",
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AidlcError(`Invalid JSON in ${target}`, {
      code: "corrupt-state",
      recovery: "Fix the JSON or run `aidlc plan-aidlc --repair` to quarantine the file. AIDLC will not reset it automatically.",
    });
  }
}
