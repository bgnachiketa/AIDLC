import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { detectRepository, skillsFor } from "../src/core/detect.js";
import { copyFixture, fixturePath } from "./helpers.js";

describe("technology detection", () => {
  it("detects each supported stack from fixtures", async () => {
    const expectations: Array<[string, string[]]> = [
      ["react", ["react"]],
      ["angular", ["angular"]],
      ["next", ["nextjs", "react"]],
      ["express", ["express", "nodejs"]],
      ["spring", ["spring-boot", "java"]],
      ["fastapi", ["fastapi", "python"]],
      ["flask", ["flask", "python"]],
      ["django", ["django", "python"]],
    ];
    for (const [name, ids] of expectations) {
      const report = await detectRepository(fixturePath(name));
      const found = report.technologies.map((technology) => technology.id);
      for (const id of ids) {
        expect(found, name).toContain(id);
      }
      expect(report.technologies.find((technology) => technology.id === ids[0])?.confidence).toBe("high");
    }
  });

  it("detects a Next.js and Express monorepo without adding Django", async () => {
    const report = await detectRepository(fixturePath("monorepo"));
    const ids = report.technologies.map((technology) => technology.id);
    expect(report.monorepo).toBe(true);
    expect(ids).toContain("nextjs");
    expect(ids).toContain("express");
    expect(ids).not.toContain("django");
    expect(report.projects.map((project) => project.root).sort()).toEqual([".", "apps/web", "services/api"]);
    const skills = skillsFor(report.technologies);
    expect(skills).toContain("react");
    expect(skills).toContain("express");
    expect(skills).not.toContain("django");
  });

  it("records medium confidence when React is only imported", async () => {
    const report = await detectRepository(fixturePath("react-inferred"));
    const react = report.technologies.find((technology) => technology.id === "react");
    expect(react?.confidence).toBe("medium");
    expect(report.assumptions.join(" ")).toMatch(/React was inferred/i);
  });

  it("records a mixed Next.js router as an assumption", async () => {
    const directory = await copyFixture("next");
    await mkdir(path.join(directory, "pages"), { recursive: true });
    await writeFile(path.join(directory, "pages", "index.tsx"), "export default function Page(){return null}\n");
    const report = await detectRepository(directory);
    expect(report.technologies.find((technology) => technology.id === "nextjs")?.details.router).toBe("mixed");
    expect(report.assumptions.join(" ")).toMatch(/both app and pages/i);
    await rm(directory, { recursive: true, force: true });
  });

  it("adds watch false for Angular tests and finds Spring security", async () => {
    const angular = await detectRepository(fixturePath("angular"));
    expect(angular.projects[0]?.commands.test?.args).toContain("--watch=false");
    expect(angular.projects[0]?.patterns.join(" ")).toMatch(/standalone/);
    const spring = await detectRepository(fixturePath("spring"));
    expect(spring.projects[0]?.databases).toContain("flyway");
    expect(spring.projects[0]?.securityControls).toContain("spring-security");
    expect(spring.projects[0]?.apiBoundaries.join(" ")).toMatch(/Spring controller/);
    expect(spring.projects[0]?.commands.test?.command).toBe("mvn");
  });
});
