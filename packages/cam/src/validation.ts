import type { CamProject } from "./model";

export function validateProject(project: CamProject): string[] {
  const errors: string[] = [];
  if (!project.name.trim()) errors.push("Enter a project name.");

  const setupIds = new Set<string>();
  for (const setup of project.setups) {
    if (!setup.id.trim() || setupIds.has(setup.id)) errors.push("Setup IDs must be present and unique.");
    setupIds.add(setup.id);
    if (!setup.name.trim()) errors.push("Enter a name for each setup.");
    if (!setup.part.documentId.trim() || !setup.part.entityId.trim()) {
      errors.push("Each setup needs a CAD document and part reference.");
    }
  }

  const processIds = new Set<string>();
  for (const process of project.processes) {
    if (!process.id.trim() || processIds.has(process.id)) errors.push("Process IDs must be present and unique.");
    processIds.add(process.id);
    if (!process.name.trim()) errors.push("Enter a name for each process.");
    if (!setupIds.has(process.setupId)) errors.push("Each process needs an existing setup.");
  }
  if (project.processPlan) {
    const plannedProcesses = new Set<string>();
    const stageIds = new Set<string>();
    for (const item of project.processPlan) {
      if (item.kind === "process") {
        if (!processIds.has(item.processId)) errors.push("Each planned operation needs an existing process.");
        if (plannedProcesses.has(item.processId)) errors.push("Each process can appear only once in the plan.");
        plannedProcesses.add(item.processId);
      } else {
        if (!item.id.trim() || stageIds.has(item.id)) errors.push("Plan stage IDs must be present and unique.");
        if (!setupIds.has(item.setupId)) errors.push("Each plan stage needs an existing setup.");
        stageIds.add(item.id);
      }
    }
    if (project.processes.some((process) => !plannedProcesses.has(process.id))) {
      errors.push("Each process needs a plan entry.");
    }
  }
  return errors;
}
