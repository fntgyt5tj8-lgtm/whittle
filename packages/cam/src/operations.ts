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
