import type { CamContextFrame, CamWorkpieceContext, CamPlanItem, CamPlanStage, CamProcess, CamProject, CamSetup } from "./model";

export function createProject(name: string): CamProject {
  return { schemaVersion: 1, name, setups: [], processes: [], processPlan: [] };
}

export function addSetup(project: CamProject, setup: CamSetup): CamProject {
  return { ...project, setups: [...project.setups, setup] };
}

export function addProcess(project: CamProject, process: CamProcess): CamProject {
  return {
    ...project,
    processes: [...project.processes, process],
    processPlan: [...getProcessPlan(project), { kind: "process", processId: process.id, stage: "main" }],
  };
}

export function addPlanStage(project: CamProject, stage: CamPlanStage): CamProject {
  return { ...project, processPlan: [...getProcessPlan(project), stage] };
}

export function getProcessPlan(project: CamProject): readonly CamPlanItem[] {
  return project.processPlan ?? project.processes.map((process) => ({
    kind: "process", processId: process.id, stage: "main",
  }));
}

export function activePlanEnd(project: CamProject): number {
  const count = getProcessPlan(project).length;
  return Math.min(project.planRollback ?? count, count);
}

export function rollBackPlan(project: CamProject, to: number): CamProject {
  if (!Number.isSafeInteger(to)) return project;
  const count = getProcessPlan(project).length;
  const planRollback = to >= count ? undefined : Math.max(0, to);
  return project.planRollback === planRollback ? project : { ...project, planRollback };
}

export function plannedOperations(project: CamProject, setupId?: string): CamProcess[] {
  const operations = new Map(project.processes.map((process) => [process.id, process]));
  return getProcessPlan(project).slice(0, activePlanEnd(project)).flatMap((entry) => {
    const process = entry.kind === "process" ? operations.get(entry.processId) : undefined;
    return process && !process.suppressed && (setupId === undefined || process.setupId === setupId) ? [process] : [];
  });
}

export function planMoveProblem(project: CamProject, id: string, targetId: string): string | undefined {
  const plan = getProcessPlan(project);
  const from = plan.findIndex((item) => item.kind === "process" && item.processId === id);
  const to = plan.findIndex((item) => item.kind === "process" && item.processId === targetId);
  const source = plan[from];
  if (source?.kind !== "process" || to < 0) return "Operations cannot move across plan stages.";
  const setup = project.processes.find((item) => item.id === id)?.setupId;
  const operations = new Map(project.processes.map((item) => [item.id, item]));
  for (const item of plan.slice(Math.min(from, to), Math.max(from, to) + 1)) {
    if (item.kind !== "process" || item.stage !== source.stage) {
      return "Operations cannot move across plan stages.";
    }
    if (operations.get(item.processId)?.setupId !== setup) return "Operations cannot move across setups.";
  }
}

export function movePlannedOperation(project: CamProject, id: string, targetId: string): CamProject {
  if (id === targetId || planMoveProblem(project, id, targetId)) return project;
  const plan = [...getProcessPlan(project)];
  const from = plan.findIndex((item) => item.kind === "process" && item.processId === id);
  const to = plan.findIndex((item) => item.kind === "process" && item.processId === targetId);
  const [entry] = plan.splice(from, 1);
  if (!entry) return project;
  plan.splice(to, 0, entry);
  return { ...project, processPlan: plan };
}

export function deletePlannedOperation(project: CamProject, id: string): CamProject {
  if (!project.processes.some((item) => item.id === id)) return project;
  const plan = getProcessPlan(project);
  const keep = (item: CamPlanItem) => item.kind !== "process" || item.processId !== id;
  const end = plan.slice(0, activePlanEnd(project)).filter(keep).length;
  return rollBackPlan({
    ...project, processPlan: plan.filter(keep), processes: project.processes.filter((item) => item.id !== id),
  }, end);
}

/** Upgrade Phase 01 setups without changing the operation plan or output frames. */
export function migrateWorkpieceContexts(project: CamProject): CamProject {
  if (project.setups.every((setup) => setup.contexts !== undefined)) return project;

  const contextIds = new Map<string, string>();
  const setups = project.setups.map((setup) => {
    if (setup.contexts) return setup;
    const contexts = new Map<string, CamWorkpieceContext>();
    for (const process of project.processes) {
      if (process.setupId !== setup.id) continue;
      const csys = process.profile?.csys ?? "world";
      const sketch = csys === "sketch" ? process.contour : undefined;
      const key = JSON.stringify([csys, sketch?.documentId, sketch?.entityId]);
      let context = contexts.get(key);
      if (!context) {
        const frame: CamContextFrame = csys === "world" ? { kind: "legacy-world" }
          : csys === "sketch" ? { kind: "legacy-sketch", sketch }
          : { kind: "native", csysId: csys.slice("datum:".length) };
        const part = setup.part;
        context = {
          id: `${setup.id}/legacy-context/${contexts.size + 1}`,
          name: contexts.size ? `Migrated context ${contexts.size + 1}` : "Main",
          frame,
          bodies: part?.kind === "body" ? [{ body: { ...part, kind: "body" }, role: "workpiece" }] : [],
        };
        contexts.set(key, context);
      }
      contextIds.set(process.id, context.id);
    }
    return { ...setup, contexts: [...contexts.values()] };
  });
  const processes = project.processes.map((process) => {
    const contextId = contextIds.get(process.id);
    if (!contextId) return process;
    if (!process.profile) return { ...process, contextId };
    const { csys, ...profile } = process.profile;
    return { ...process, contextId, profile };
  });
  return { ...project, setups, processes };
}
