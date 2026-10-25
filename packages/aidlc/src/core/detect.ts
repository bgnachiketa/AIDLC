import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { pathExists, toPosix } from "./fsutil.js";
import type { CheckKind, CommandSpec, TechnologyId } from "./schema.js";

export interface TechnologyDetection {
  id: TechnologyId;
  name: string;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  roots: string[];
  role: "application" | "toolchain";
  details: Record<string, string>;
}

export interface ProjectDetection {
  root: string;
  name: string;
  technologies: TechnologyDetection[];
  commands: Record<CheckKind, CommandSpec | null>;
  databases: string[];
  securityControls: string[];
  patterns: string[];
  apiBoundaries: string[];
  testLayout: string[];
  manifests: string[];
  assumptions: string[];
}

export interface DetectionReport {
  monorepo: boolean;
  projects: ProjectDetection[];
  technologies: TechnologyDetection[];
  warnings: string[];
  assumptions: string[];
  ciFiles: string[];
  agentFiles: string[];
  truncated: boolean;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".next",
  "out",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".gradle",
  "vendor",
  ".aidlc",
  "build",
]);

const TECH_NAMES: Record<TechnologyId, string> = {
  react: "React",
  angular: "Angular",
  nextjs: "Next.js",
  nodejs: "Node.js",
  express: "Express",
  java: "Java",
  "spring-boot": "Spring Boot",
  python: "Python",
  fastapi: "FastAPI",
  flask: "Flask",
  django: "Django",
};

interface PackageJson {
  name?: string;
  workspaces?: string[] | { packages?: string[] };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export async function detectRepository(root: string): Promise<DetectionReport> {
  const warnings: string[] = [];
  const assumptions: string[] = [];
  const projectRoots = await discoverProjectRoots(root);
  const projects: ProjectDetection[] = [];
  for (const projectRoot of projectRoots.slice(0, 30)) {
    projects.push(await detectProject(root, projectRoot));
  }
  if (projectRoots.length > 30) {
    warnings.push("Project discovery stopped after 30 manifests.");
  }
  const technologies = mergeTechnologies(projects);
  const ciFiles = await listWorkflows(root);
  const agentFiles = await listAgentFiles(root);
  for (const project of projects) {
    assumptions.push(...project.assumptions);
  }
  return {
    monorepo: projects.filter((project) => project.root !== ".").length > 0,
    projects,
    technologies,
    warnings,
    assumptions,
    ciFiles,
    agentFiles,
    truncated: projectRoots.length > 30,
  };
}

export function skillsFor(technologies: TechnologyDetection[]): TechnologyId[] {
  const ids = new Set(technologies.map((technology) => technology.id));
  const skills: TechnologyId[] = [];
  const add = (id: TechnologyId) => {
    if (!skills.includes(id)) {
      skills.push(id);
    }
  };
  if (ids.has("react") || ids.has("nextjs")) {
    add("react");
  }
  if (ids.has("angular")) add("angular");
  if (ids.has("nextjs")) add("nextjs");
  if (ids.has("express")) {
    add("express");
    add("nodejs");
  } else if (technologies.some((technology) => technology.id === "nodejs" && technology.role === "application")) {
    add("nodejs");
  }
  if (ids.has("spring-boot")) {
    add("spring-boot");
    add("java");
  } else if (ids.has("java")) {
    add("java");
  }
  if (ids.has("fastapi")) add("fastapi");
  if (ids.has("flask")) add("flask");
  if (ids.has("django")) add("django");
  if (ids.has("python") || ids.has("fastapi") || ids.has("flask") || ids.has("django")) {
    add("python");
  }
  return skills;
}

async function discoverProjectRoots(root: string): Promise<string[]> {
  const roots = new Set<string>(["."]);
  const patterns = await workspacePatterns(root);
  for (const pattern of patterns) {
    for (const expanded of await expandPattern(root, pattern)) {
      if (await hasManifest(path.join(root, expanded)) && !(await isNestedFixture(root, expanded))) {
        roots.add(toPosix(expanded));
      }
    }
  }
  const nested = await findNestedManifests(root, root, 0);
  for (const relative of nested) {
    if (!(await isNestedFixture(root, relative))) {
      roots.add(relative);
    }
  }
  return [...roots].sort((left, right) => left.localeCompare(right));
}

async function workspacePatterns(root: string): Promise<string[]> {
  const patterns: string[] = [];
  const pkg = await readPackage(path.join(root, "package.json"));
  if (Array.isArray(pkg?.workspaces)) {
    patterns.push(...pkg.workspaces);
  } else if (pkg?.workspaces && Array.isArray(pkg.workspaces.packages)) {
    patterns.push(...pkg.workspaces.packages);
  }
  const pnpm = await readMaybe(path.join(root, "pnpm-workspace.yaml"));
  if (pnpm) {
    try {
      const document = parse(pnpm) as { packages?: unknown };
      if (Array.isArray(document.packages)) {
        patterns.push(...document.packages.filter((item): item is string => typeof item === "string"));
      }
    } catch {
      // Ignore an unreadable workspace file and continue with other evidence.
    }
  }
  const lerna = await readMaybe(path.join(root, "lerna.json"));
  if (lerna) {
    try {
      const document = JSON.parse(lerna) as { packages?: unknown };
      if (Array.isArray(document.packages)) {
        patterns.push(...document.packages.filter((item): item is string => typeof item === "string"));
      }
    } catch {
      // Ignore malformed lerna.json.
    }
  }
  return patterns;
}

async function expandPattern(root: string, pattern: string): Promise<string[]> {
  if (!pattern.includes("*")) {
    return [pattern.replace(/^\.\//, "").replace(/\/$/, "")];
  }
  const star = pattern.indexOf("*");
  const base = pattern.slice(0, star).replace(/\/$/, "").replace(/^\.\//, "");
  const directory = path.join(root, base);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name))
    .map((entry) => toPosix(path.join(base, entry.name)));
}

async function findNestedManifests(repoRoot: string, directory: string, depth: number): Promise<string[]> {
  if (depth > 3) {
    return [];
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const absolute = path.join(directory, entry.name);
    const relative = toPosix(path.relative(repoRoot, absolute));
    if (await isNestedFixture(repoRoot, relative)) {
      continue;
    }
    if (depth > 0 && (await hasManifest(absolute))) {
      found.push(relative);
    }
    if (depth < 3) {
      found.push(...(await findNestedManifests(repoRoot, absolute, depth + 1)));
    }
  }
  return found;
}

async function isNestedFixture(repoRoot: string, relative: string): Promise<boolean> {
  if (relative === ".") {
    return false;
  }
  return pathExists(path.join(repoRoot, relative, ".aidlc-fixture"));
}

async function hasManifest(directory: string): Promise<boolean> {
  const names = ["package.json", "pom.xml", "build.gradle", "build.gradle.kts", "pyproject.toml", "requirements.txt", "manage.py", "setup.py", "Pipfile"];
  for (const name of names) {
    if (await pathExists(path.join(directory, name))) {
      return true;
    }
  }
  return false;
}

async function detectProject(repoRoot: string, projectRoot: string): Promise<ProjectDetection> {
  const absolute = path.join(repoRoot, projectRoot === "." ? "" : projectRoot);
  const pkg = await readPackage(path.join(absolute, "package.json"));
  const technologies: TechnologyDetection[] = [];
  const assumptions: string[] = [];
  const manifests: string[] = [];
  const deps = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
    ...(pkg?.peerDependencies ?? {}),
  };
  if (pkg) {
    manifests.push(joinRel(projectRoot, "package.json"));
  }
  const pom = await readMaybe(path.join(absolute, "pom.xml"));
  const gradle = (await readMaybe(path.join(absolute, "build.gradle"))) ?? (await readMaybe(path.join(absolute, "build.gradle.kts")));
  const requirements = await readMaybe(path.join(absolute, "requirements.txt"));
  const pyproject = await readMaybe(path.join(absolute, "pyproject.toml"));
  const manage = await readMaybe(path.join(absolute, "manage.py"));
  if (pom) manifests.push(joinRel(projectRoot, "pom.xml"));
  if (await pathExists(path.join(absolute, "build.gradle"))) manifests.push(joinRel(projectRoot, "build.gradle"));
  if (await pathExists(path.join(absolute, "build.gradle.kts"))) manifests.push(joinRel(projectRoot, "build.gradle.kts"));
  if (requirements) manifests.push(joinRel(projectRoot, "requirements.txt"));
  if (pyproject) manifests.push(joinRel(projectRoot, "pyproject.toml"));
  if (manage) manifests.push(joinRel(projectRoot, "manage.py"));

  const pythonText = `${requirements ?? ""}\n${pyproject ?? ""}`;
  const javaText = `${pom ?? ""}\n${gradle ?? ""}`;

  if (deps.next || (await existsAny(absolute, ["next.config.js", "next.config.mjs", "next.config.ts"]))) {
    const evidence = [];
    if (deps.next) evidence.push(`${joinRel(projectRoot, "package.json")}: next`);
    const config = await firstExisting(absolute, ["next.config.ts", "next.config.mjs", "next.config.js"]);
    if (config) evidence.push(joinRel(projectRoot, config));
    const hasApp = await pathExists(path.join(absolute, "app"));
    const hasPages = await pathExists(path.join(absolute, "pages"));
    const router = hasApp && hasPages ? "mixed" : hasApp ? "app" : hasPages ? "pages" : "unknown";
    if (router === "mixed") {
      assumptions.push(`${projectRoot}: Next.js has both app and pages directories. Skills cover both and follow the local route style.`);
    }
    technologies.push(tech("nextjs", "high", evidence, projectRoot, "application", { router }));
  }
  if (deps.react) {
    technologies.push(tech("react", "high", [`${joinRel(projectRoot, "package.json")}: react`], projectRoot, "application", {}));
  } else if (!deps.next && (await sourceImports(absolute, /from ["']react["']|require\(["']react["']\)/))) {
    assumptions.push(`${projectRoot}: React was inferred from source imports without a dependency declaration.`);
    technologies.push(tech("react", "medium", ["source import of react"], projectRoot, "application", {}));
  }
  if (deps["@angular/core"] || (await pathExists(path.join(absolute, "angular.json")))) {
    const evidence = [];
    if (deps["@angular/core"]) evidence.push(`${joinRel(projectRoot, "package.json")}: @angular/core`);
    if (await pathExists(path.join(absolute, "angular.json"))) evidence.push(joinRel(projectRoot, "angular.json"));
    const style = await angularStyle(absolute);
    technologies.push(tech("angular", "high", evidence, projectRoot, "application", { style }));
  }
  if (deps.express) {
    technologies.push(tech("express", "high", [`${joinRel(projectRoot, "package.json")}: express`], projectRoot, "application", {}));
  } else if (await sourceImports(absolute, /from ["']express["']|require\(["']express["']\)/)) {
    assumptions.push(`${projectRoot}: Express was inferred from source without a dependency declaration.`);
    technologies.push(tech("express", "medium", ["source import of express"], projectRoot, "application", {}));
  }
  if (pkg) {
    const frontend = technologies.some((item) => item.id === "react" || item.id === "angular" || item.id === "nextjs");
    const backend = technologies.some((item) => item.id === "express");
    technologies.push(
      tech(
        "nodejs",
        "high",
        [joinRel(projectRoot, "package.json")],
        projectRoot,
        frontend && !backend ? "toolchain" : "application",
        {},
      ),
    );
  }
  if (/spring-boot/i.test(javaText)) {
    technologies.push(tech("spring-boot", "high", ["Spring Boot build declaration"], projectRoot, "application", {}));
    technologies.push(tech("java", "high", ["JVM build file"], projectRoot, "application", {}));
  } else if (pom || gradle) {
    technologies.push(tech("java", "high", [pom ? "pom.xml" : "Gradle build file"], projectRoot, "application", {}));
  }
  const pythonManifest = Boolean(requirements || pyproject || manage || (await pathExists(path.join(absolute, "Pipfile"))));
  if (/fastapi/i.test(pythonText)) {
    technologies.push(tech("fastapi", "high", ["fastapi dependency"], projectRoot, "application", {}));
  }
  if (/flask/i.test(pythonText)) {
    technologies.push(tech("flask", "high", ["flask dependency"], projectRoot, "application", {}));
  }
  if (/django/i.test(pythonText) || (manage?.includes("django") ?? false)) {
    technologies.push(tech("django", "high", ["django dependency or manage.py"], projectRoot, "application", {}));
  }
  if (pythonManifest || technologies.some((item) => item.id === "fastapi" || item.id === "flask" || item.id === "django")) {
    technologies.push(tech("python", "high", ["Python manifest"], projectRoot, "application", {}));
  }

  const databases = await detectDatabases(absolute, projectRoot, deps, javaText, pythonText);
  const securityControls = await detectSecurity(absolute, projectRoot, deps, javaText, pythonText);
  const patterns = await detectPatterns(absolute, technologies);
  const apiBoundaries = await detectApis(absolute, projectRoot);
  const testLayout = await detectTests(absolute, projectRoot);
  const commands = await discoverCommands(repoRoot, projectRoot, pkg, absolute);

  return {
    root: projectRoot,
    name: pkg?.name ?? (projectRoot === "." ? path.basename(repoRoot) : path.basename(projectRoot)),
    technologies,
    commands,
    databases,
    securityControls,
    patterns,
    apiBoundaries,
    testLayout,
    manifests,
    assumptions,
  };
}

function tech(
  id: TechnologyId,
  confidence: "high" | "medium" | "low",
  evidence: string[],
  root: string,
  role: "application" | "toolchain",
  details: Record<string, string>,
): TechnologyDetection {
  return { id, name: TECH_NAMES[id], confidence, evidence, roots: [root], role, details };
}

async function discoverCommands(
  repoRoot: string,
  projectRoot: string,
  pkg: PackageJson | null,
  absolute: string,
): Promise<Record<CheckKind, CommandSpec | null>> {
  const commands: Record<CheckKind, CommandSpec | null> = {
    format: null,
    lint: null,
    typecheck: null,
    test: null,
    integration: null,
    e2e: null,
    build: null,
    security: null,
  };
  const cwd = projectRoot === "." ? "." : projectRoot;
  const scripts = pkg?.scripts ?? {};
  const assign = (kind: CheckKind, script: string, source: string) => {
    const spec = scriptToSpec(script, cwd, source, kind);
    if (spec) {
      commands[kind] = spec;
    }
  };
  if (scripts["format:check"]) assign("format", scripts["format:check"], "package.json scripts.format:check");
  else if (scripts.format && /check/.test(scripts.format) && !/--write/.test(scripts.format)) {
    assign("format", scripts.format, "package.json scripts.format");
  }
  if (scripts.lint) assign("lint", scripts.lint, "package.json scripts.lint");
  if (scripts.typecheck) assign("typecheck", scripts.typecheck, "package.json scripts.typecheck");
  else if (scripts["type-check"]) assign("typecheck", scripts["type-check"], "package.json scripts.type-check");
  if (scripts["test:unit"]) assign("test", scripts["test:unit"], "package.json scripts.test:unit");
  else if (scripts.test) assign("test", scripts.test, "package.json scripts.test");
  if (scripts["test:integration"]) assign("integration", scripts["test:integration"], "package.json scripts.test:integration");
  else if (scripts["test:api"]) assign("integration", scripts["test:api"], "package.json scripts.test:api");
  if (scripts["test:e2e"]) assign("e2e", scripts["test:e2e"], "package.json scripts.test:e2e");
  else if (scripts.e2e) assign("e2e", scripts.e2e, "package.json scripts.e2e");
  if (scripts.build) assign("build", scripts.build, "package.json scripts.build");

  if (!commands.test && (await pathExists(path.join(absolute, "pom.xml")))) {
    const wrapper = await firstExisting(absolute, ["mvnw", "mvnw.cmd"]);
    commands.test = {
      command: wrapper ? toPosix(path.join(cwd, wrapper)) : "mvn",
      args: ["-B", "test"],
      cwd,
      source: wrapper ? wrapper : "pom.xml",
    };
    commands.build = {
      command: wrapper ? toPosix(path.join(cwd, wrapper)) : "mvn",
      args: ["-B", "-DskipTests", "package"],
      cwd,
      source: "pom.xml",
    };
  }
  if (!commands.test && ((await pathExists(path.join(absolute, "build.gradle"))) || (await pathExists(path.join(absolute, "build.gradle.kts"))))) {
    const wrapper = await firstExisting(absolute, ["gradlew", "gradlew.bat"]);
    commands.test = {
      command: wrapper ? toPosix(path.join(cwd, wrapper)) : "gradle",
      args: ["test"],
      cwd,
      source: "Gradle build file",
    };
  }
  const python = await pythonCommand(absolute);
  if (!commands.test && python && (await pythonHasPytest(absolute))) {
    commands.test = { command: python, args: ["-m", "pytest"], cwd, source: "pytest discovery" };
  } else if (!commands.test && python && (await pathExists(path.join(absolute, "manage.py")))) {
    commands.test = { command: python, args: ["manage.py", "test"], cwd, source: "manage.py" };
  }
  if (pkg && !commands.typecheck && (await pathExists(path.join(absolute, "tsconfig.json")))) {
    commands.typecheck = { command: "npx", args: ["tsc", "--noEmit", "-p", "tsconfig.json"], cwd, source: "tsconfig.json" };
  }
  void repoRoot;
  return commands;
}

function scriptToSpec(script: string, cwd: string, source: string, kind: CheckKind): CommandSpec | null {
  const angularWatch = kind === "test" && /\bng\s+test\b/.test(script);
  return {
    command: "npm",
    args: angularWatch ? ["run", scriptName(source), "--", "--watch=false"] : ["run", scriptName(source)],
    cwd,
    source,
  };
}

function scriptName(source: string): string {
  const match = /scripts\.([A-Za-z0-9:_-]+)/.exec(source);
  return match?.[1] ?? "test";
}

async function pythonCommand(directory: string): Promise<string | null> {
  if (await pathExists(path.join(directory, ".venv", "bin", "python"))) {
    return toPosix(path.join(".venv", "bin", "python"));
  }
  if (await pathExists(path.join(directory, "venv", "bin", "python"))) {
    return toPosix(path.join("venv", "bin", "python"));
  }
  return "python3";
}

async function pythonHasPytest(directory: string): Promise<boolean> {
  const requirements = (await readMaybe(path.join(directory, "requirements.txt"))) ?? "";
  const pyproject = (await readMaybe(path.join(directory, "pyproject.toml"))) ?? "";
  return /pytest/i.test(`${requirements}\n${pyproject}`);
}

async function detectDatabases(
  directory: string,
  projectRoot: string,
  deps: Record<string, string>,
  javaText: string,
  pythonText: string,
): Promise<string[]> {
  const found: string[] = [];
  if (deps.prisma || (await pathExists(path.join(directory, "prisma", "schema.prisma")))) found.push("prisma");
  if (deps.typeorm) found.push("typeorm");
  if (deps.sequelize) found.push("sequelize");
  if (deps.knex) found.push("knex");
  if (deps.mongoose) found.push("mongoose");
  if (/flyway/i.test(javaText)) found.push("flyway");
  if (/liquibase/i.test(javaText)) found.push("liquibase");
  if (await pathExists(path.join(directory, "alembic.ini"))) found.push("alembic");
  if (/django/i.test(pythonText)) found.push("django-orm");
  void projectRoot;
  return found;
}

async function detectSecurity(
  directory: string,
  projectRoot: string,
  deps: Record<string, string>,
  javaText: string,
  pythonText: string,
): Promise<string[]> {
  const found: string[] = [];
  if (deps.helmet) found.push("helmet");
  if (deps.cors) found.push("cors");
  if (deps["csurf"] || deps["csrf-csrf"]) found.push("csrf-middleware");
  if (/spring-boot-starter-security/i.test(javaText)) found.push("spring-security");
  if (/CsrfViewMiddleware|django.middleware.csrf/i.test(pythonText)) found.push("django-csrf");
  if (await pathExists(path.join(directory, ".github", "dependabot.yml"))) found.push("dependabot");
  void projectRoot;
  return found;
}

async function detectPatterns(directory: string, technologies: TechnologyDetection[]): Promise<string[]> {
  const patterns: string[] = [];
  const next = technologies.find((item) => item.id === "nextjs");
  if (next?.details.router === "app") patterns.push("next-app-router");
  if (next?.details.router === "pages") patterns.push("next-pages-router");
  if (next?.details.router === "mixed") patterns.push("next-mixed-router");
  const angular = technologies.find((item) => item.id === "angular");
  if (angular?.details.style) patterns.push(`angular-${angular.details.style}`);
  if (await pathExists(path.join(directory, "src", "main", "java"))) patterns.push("spring-layered");
  if (technologies.some((item) => item.id === "django")) patterns.push("django-apps");
  if (technologies.some((item) => item.id === "flask")) patterns.push("flask-factory-or-app");
  return patterns;
}

async function detectApis(directory: string, projectRoot: string): Promise<string[]> {
  const hits: string[] = [];
  if (await pathExists(path.join(directory, "app", "api"))) hits.push(`${joinRel(projectRoot, "app/api")}: route handlers`);
  const samples = await sampleFiles(directory, 40);
  for (const file of samples) {
    const text = await readMaybe(file.absolute);
    if (!text) continue;
    if (/@RestController/.test(text)) hits.push(`${file.relative}: Spring controller`);
    if (/APIRouter|FastAPI\(/.test(text)) hits.push(`${file.relative}: FastAPI router`);
    if (/Blueprint\(/.test(text)) hits.push(`${file.relative}: Flask blueprint`);
    if (/express\(\)|Router\(\)/.test(text) && /\.(get|post|put|delete)\(/.test(text)) {
      hits.push(`${file.relative}: Express route`);
    }
    if (file.relative.endsWith("urls.py")) hits.push(`${file.relative}: Django URLs`);
  }
  return [...new Set(hits)].slice(0, 20);
}

async function detectTests(directory: string, projectRoot: string): Promise<string[]> {
  const layout: string[] = [];
  for (const name of ["tests", "test", "src/test", "__tests__"]) {
    if (await pathExists(path.join(directory, name))) {
      layout.push(joinRel(projectRoot, name));
    }
  }
  return layout;
}

async function angularStyle(directory: string): Promise<string> {
  const files = await sampleFiles(directory, 30);
  let standalone = false;
  let module = false;
  for (const file of files) {
    if (!file.relative.endsWith(".ts")) continue;
    const text = await readMaybe(file.absolute);
    if (!text) continue;
    if (/standalone:\s*true/.test(text)) standalone = true;
    if (/@NgModule\(/.test(text)) module = true;
  }
  if (standalone && module) return "mixed";
  if (standalone) return "standalone";
  if (module) return "ngmodule";
  return "unknown";
}

async function sourceImports(directory: string, pattern: RegExp): Promise<boolean> {
  const files = await sampleFiles(directory, 40);
  for (const file of files) {
    if (!/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(file.relative)) continue;
    const text = await readMaybe(file.absolute);
    if (text && pattern.test(text)) return true;
  }
  return false;
}

async function sampleFiles(directory: string, limit: number): Promise<{ absolute: string; relative: string }[]> {
  const found: { absolute: string; relative: string }[] = [];
  await walk(directory, directory, 0, found, limit);
  return found;
}

async function walk(
  root: string,
  directory: string,
  depth: number,
  found: { absolute: string; relative: string }[],
  limit: number,
): Promise<void> {
  if (found.length >= limit || depth > 6) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (found.length >= limit) return;
    if (entry.name === ".aidlc-fixture") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (await pathExists(path.join(absolute, ".aidlc-fixture"))) continue;
      await walk(root, absolute, depth + 1, found, limit);
    } else if (/\.(js|jsx|ts|tsx|mjs|cjs|py|java|xml|gradle|kts)$/.test(entry.name)) {
      found.push({ absolute, relative: toPosix(path.relative(root, absolute)) });
    }
  }
}

function mergeTechnologies(projects: ProjectDetection[]): TechnologyDetection[] {
  const merged = new Map<TechnologyId, TechnologyDetection>();
  for (const project of projects) {
    for (const technology of project.technologies) {
      const existing = merged.get(technology.id);
      if (!existing) {
        merged.set(technology.id, {
          ...technology,
          evidence: [...technology.evidence],
          roots: [...technology.roots],
          details: { ...technology.details },
        });
        continue;
      }
      existing.evidence.push(...technology.evidence);
      existing.roots.push(...technology.roots.filter((root) => !existing.roots.includes(root)));
      if (confidenceRank(technology.confidence) > confidenceRank(existing.confidence)) {
        existing.confidence = technology.confidence;
      }
      if (technology.role === "application") {
        existing.role = "application";
      }
      existing.details = { ...existing.details, ...technology.details };
    }
  }
  return [...merged.values()];
}

function confidenceRank(value: "high" | "medium" | "low"): number {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  return 1;
}

async function listWorkflows(root: string): Promise<string[]> {
  const directory = path.join(root, ".github", "workflows");
  try {
    const entries = await readdir(directory);
    return entries.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml")).map((name) => `.github/workflows/${name}`);
  } catch {
    return [];
  }
}

async function listAgentFiles(root: string): Promise<string[]> {
  const candidates = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md", "GEMINI.md"];
  const found: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(path.join(root, candidate))) found.push(candidate);
  }
  if (await pathExists(path.join(root, ".cursor", "rules"))) found.push(".cursor/rules");
  if (await pathExists(path.join(root, ".claude"))) found.push(".claude");
  if (await pathExists(path.join(root, ".agents"))) found.push(".agents");
  return found;
}

async function readPackage(file: string): Promise<PackageJson | null> {
  const text = await readMaybe(file);
  if (!text) return null;
  try {
    return JSON.parse(text) as PackageJson;
  } catch {
    return null;
  }
}

async function readMaybe(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 1_000_000) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function existsAny(directory: string, names: string[]): Promise<boolean> {
  return (await firstExisting(directory, names)) !== null;
}

async function firstExisting(directory: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    if (await pathExists(path.join(directory, name))) return name;
  }
  return null;
}

function joinRel(root: string, leaf: string): string {
  if (root === "." || root === "") return leaf;
  return `${root}/${leaf}`;
}
