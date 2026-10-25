import type { PlanStatus, Task } from "./schema.js";
import { AidlcError } from "./errors.js";

export function taskNumber(id: string): number {
  return Number(id.slice(1));
}

export function compareTaskId(left: string, right: string): number {
  return taskNumber(left) - taskNumber(right);
}

export function orderTasks(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    indegree.set(task.id, 0);
    dependents.set(task.id, []);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) {
        throw new AidlcError(`Task ${task.id} depends on unknown task ${dependency}`, {
          code: "invalid-plan",
          recovery: "Repair the plan so every dependency refers to an existing task id.",
        });
      }
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
      dependents.get(dependency)?.push(task.id);
    }
  }
  const ready = tasks.filter((task) => (indegree.get(task.id) ?? 0) === 0).map((task) => task.id);
  ready.sort(compareTaskId);
  const ordered: Task[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (!id) {
      break;
    }
    const task = byId.get(id);
    if (task) {
      ordered.push(task);
    }
    const children = [...(dependents.get(id) ?? [])].sort(compareTaskId);
    for (const child of children) {
      const next = (indegree.get(child) ?? 1) - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(child);
        ready.sort(compareTaskId);
      }
    }
  }
  if (ordered.length !== tasks.length) {
    throw new AidlcError("Task dependencies contain a cycle", {
      code: "invalid-plan",
      recovery: "Remove the cycle. Task ids must form a directed acyclic graph.",
    });
  }
  return ordered;
}

export function dependenciesSatisfied(task: Task, tasks: Task[]): boolean {
  return task.dependsOn.every((id) => {
    const dependency = tasks.find((candidate) => candidate.id === id);
    return dependency?.status === "completed" || dependency?.status === "skipped";
  });
}

export function rollupStatus(tasks: Task[], current: PlanStatus): PlanStatus {
  if (
    current === "cancelled" ||
    current === "needs-clarification" ||
    current === "draft" ||
    current === "awaiting-approval"
  ) {
    return current;
  }
  if (tasks.length > 0 && tasks.every((task) => task.status === "completed" || task.status === "skipped")) {
    return "completed";
  }
  if (tasks.some((task) => task.status === "blocked")) {
    return "blocked";
  }
  if (current === "approved" && tasks.every((task) => task.status === "pending")) {
    return "approved";
  }
  if (tasks.some((task) => task.status === "in-progress" || task.status === "completed" || task.status === "skipped")) {
    return "in-progress";
  }
  return current;
}
