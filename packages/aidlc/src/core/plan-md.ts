import type { Plan } from "./schema.js";

export function renderPlanMarkdown(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`# ${plan.title}`);
  lines.push("");
  lines.push("The JSON file next to this document is the authoritative plan. Do not infer task completion from this Markdown.");
  lines.push("");
  lines.push(`- Plan ID: \`${plan.id}\``);
  lines.push(`- Change type: ${plan.changeType}`);
  lines.push(`- Status: ${plan.status}`);
  lines.push(`- Repository: \`${plan.repositoryId}\``);
  lines.push(`- Path identity: \`${plan.repositoryPathId}\``);
  lines.push(`- Created: ${plan.createdAt}`);
  lines.push(`- Updated: ${plan.updatedAt}`);
  lines.push(`- Authoring: ${plan.authoring.mode}. ${plan.authoring.note}`);
  lines.push("");
  section(lines, "Requirements", [plan.requirements]);
  section(lines, "Problem statement", [plan.problemStatement]);
  section(lines, "Scope", plan.scope);
  section(lines, "Out of scope", plan.outOfScope);
  section(lines, "Architecture", [plan.architecture.summary, ...plan.architecture.affectedComponents.map((item) => `Affected: ${item}`)]);
  section(lines, "Design", [plan.design]);
  section(lines, "Alternatives", plan.alternatives.map((item) => `${item.name}: ${item.tradeoffs}`));
  lines.push("## Tasks");
  lines.push("");
  lines.push("| ID | Status | Kind | Title | Depends on |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const task of plan.tasks) {
    lines.push(`| ${task.id} | ${task.status} | ${task.kind} | ${escapeCell(task.title)} | ${task.dependsOn.join(", ") || "—"} |`);
  }
  lines.push("");
  for (const task of plan.tasks) {
    lines.push(`### ${task.id}. ${task.title}`);
    lines.push("");
    lines.push(task.description);
    lines.push("");
    lines.push(`Acceptance: ${task.acceptanceCriteria.join("; ") || "None recorded."}`);
    if (task.blockers.length > 0) {
      lines.push(`Blockers: ${task.blockers.join("; ")}`);
    }
    lines.push("");
  }
  section(lines, "Acceptance criteria", plan.acceptanceCriteria);
  section(lines, "Test strategy", plan.testStrategy);
  section(lines, "Security and privacy", plan.security);
  section(lines, "Performance and reliability", plan.performance);
  section(lines, "Database and migrations", plan.database);
  section(lines, "Observability", plan.observability);
  section(lines, "Rollback", plan.rollback);
  section(lines, "Documentation", plan.documentation);
  section(lines, "Risks and assumptions", [
    ...plan.risks,
    ...plan.assumptions.map((item) => `${item.blocking ? "Blocking assumption" : "Assumption"} ${item.id}: ${item.text}`),
  ]);
  lines.push("## Approval");
  lines.push("");
  lines.push(`Status: ${plan.approval.status}`);
  lines.push(`At: ${plan.approval.at ?? "not recorded"}`);
  lines.push(`Note: ${plan.approval.note ?? "none"}`);
  lines.push("");
  lines.push("## Validation evidence");
  lines.push("");
  if (plan.validation.length === 0) {
    lines.push("No validation evidence recorded.");
  } else {
    for (const item of plan.validation) {
      lines.push(`- ${item.status} ${item.command ?? item.source}: ${item.summary}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}`;
}

function section(lines: string[], title: string, items: string[]): void {
  lines.push(`## ${title}`);
  lines.push("");
  if (items.length === 0) {
    lines.push("None recorded.");
  } else if (items.length === 1) {
    lines.push(items[0] ?? "");
  } else {
    for (const item of items) {
      lines.push(`- ${item}`);
    }
  }
  lines.push("");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}
