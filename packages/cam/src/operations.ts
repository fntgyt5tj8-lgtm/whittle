import type { CamPlanItem, CamPlanStage, CamProcess, CamProject, CamSetup } from "./model";

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
