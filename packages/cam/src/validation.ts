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

/** Check the shape of a saved project before the workspace reads its fields. */
export function isCamProject(value: unknown): value is CamProject {
  const record = (item: unknown): item is Record<string, unknown> =>
    !!item && typeof item === "object" && !Array.isArray(item);
  const geometry = (item: unknown) => record(item) && typeof item.documentId === "string"
    && typeof item.entityId === "string" && (item.kind === "body" || item.kind === "sketch");
  const profile = (item: unknown) => record(item)
    && (item.csys === undefined || item.csys === "world" || item.csys === "sketch"
      || (typeof item.csys === "string" && item.csys.startsWith("datum:") && item.csys.length > 6))
    && (item.side === undefined || item.side === "inside" || item.side === "outside")
    && (item.direction === undefined || item.direction === "cw" || item.direction === "ccw")
    && ["diameter", "depth", "clearance", "feed", "plungeFeed"].every((key) =>
      item[key] === undefined || typeof item[key] === "string");

  return record(value) && value.schemaVersion === 1 && typeof value.name === "string"
    && Array.isArray(value.setups) && value.setups.every((item) => record(item)
      && typeof item.id === "string" && typeof item.name === "string" && geometry(item.part))
    && Array.isArray(value.processes) && value.processes.every((item) => record(item)
      && typeof item.id === "string" && typeof item.name === "string" && typeof item.setupId === "string"
      && item.kind === "profile" && (item.contour === undefined || geometry(item.contour))
      && (item.profile === undefined || profile(item.profile))
      && (item.track === undefined || (record(item.track)
        && typeof item.track.id === "string" && typeof item.track.unitId === "string")))
    && (value.processPlan === undefined || (Array.isArray(value.processPlan) && value.processPlan.every((item) =>
      record(item) && (item.kind === "process"
        ? typeof item.processId === "string" && (item.stage === "main" || item.stage === "sub")
        : (item.kind === "transfer" || item.kind === "ejection")
          && typeof item.id === "string" && typeof item.setupId === "string"))));
}
