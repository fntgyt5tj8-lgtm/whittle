import { CAM_TOOL_COMPONENT_ROLES, type CamProcess, type CamProject, type CamToolComponentRole, type CamToolPosition } from "./model";
import { canCut } from "./toolGeometry";

export function validateOperationTooling(process: CamProcess, tools: readonly CamToolPosition[] = []): string[] {
  const errors: string[] = [];
  if (process.toolPositionId !== undefined && !tools.some((tool) => tool.id === process.toolPositionId)) {
    errors.push(`${process.name} references a missing tool position (${process.toolPositionId}).`);
  }
  for (const [label, value] of [
    ["cut feed", process.profile?.feed],
    ["plunge feed", process.profile?.plungeFeed],
    ["spindle speed", process.profile?.spindleRpm],
  ]) {
    if (value !== undefined && value.trim() && (!Number.isFinite(Number(value)) || Number(value) <= 0)) {
      errors.push(`${process.name} needs a positive ${label}.`);
    }
  }
  return errors;
}

export function validateProject(project: CamProject): string[] {
  const errors: string[] = [];
  if (!project.name.trim()) errors.push("Enter a project name.");

  const contextIds = new Set<string>();
  const setupIds = new Set<string>();
  for (const setup of project.setups) {
    if (!setup.id.trim() || setupIds.has(setup.id)) errors.push("Setup IDs must be present and unique.");
    setupIds.add(setup.id);
    if (!setup.name.trim()) errors.push("Enter a name for each setup.");
    if (setup.part && (!setup.part.documentId.trim() || !setup.part.entityId.trim())) {
      errors.push("Each setup needs a CAD document and part reference.");
    }
    for (const context of setup.contexts ?? []) {
      if (!context.id.trim() || contextIds.has(context.id)) errors.push("Workpiece context IDs must be present and unique.");
      contextIds.add(context.id);
      if (!context.name.trim()) errors.push("Enter a name for each workpiece context.");
      if (context.frame.kind === "native" && !context.frame.csysId.trim()) {
        errors.push(`${context.name} needs a native coordinate system.`);
      }
      const assignments = new Set<string>();
      for (const { body, role } of context.bodies) {
        const key = JSON.stringify([body.documentId, body.entityId, role]);
        if (!body.documentId.trim() || !body.entityId.trim() || assignments.has(key)) {
          errors.push(`${context.name} needs valid, unique body assignments.`);
        }
        assignments.add(key);
      }
    }
  }

  const processIds = new Set<string>();
  for (const process of project.processes) {
    if (!process.id.trim() || processIds.has(process.id)) errors.push("Process IDs must be present and unique.");
    processIds.add(process.id);
    if (!process.name.trim()) errors.push("Enter a name for each process.");
    errors.push(...validateOperationTooling(process, project.toolPositions));
    const setup = project.setups.find((item) => item.id === process.setupId);
    if (!setup) errors.push("Each process needs an existing setup.");
    if (setup?.contexts && !setup.contexts.some((item) => item.id === process.contextId)) {
      errors.push(`${process.name} needs an existing workpiece context in its setup.`);
    }
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
  const positive = (item: unknown) => typeof item === "number" && Number.isFinite(item) && item > 0;
  const anchor = (item: unknown) => item === undefined || (record(item) && Array.isArray(item.bounds)
    && item.bounds.length === 2 && item.bounds.every(vector)
    && positive(item.edgeCount) && Number.isInteger(item.edgeCount)
    && positive(item.faceCount) && Number.isInteger(item.faceCount));
  const edge = (item: unknown) => record(item) && typeof item.bodyId === "string" && anchor(item.anchor) && vector(item.mid)
    && vector(item.tangent) && typeof item.curve === "string" && positive(item.length);
  const floor = (item: unknown) => record(item) && typeof item.bodyId === "string" && anchor(item.anchor) && vector(item.center)
    && vector(item.normal) && item.surface === "PLANE" && positive(item.area);
  const context = (item: unknown) => record(item) && typeof item.id === "string" && typeof item.name === "string"
    && record(item.frame) && (item.frame.kind === "legacy-world"
      || (item.frame.kind === "legacy-sketch" && (item.frame.sketch === undefined || geometry(item.frame.sketch)))
      || (item.frame.kind === "native" && typeof item.frame.csysId === "string"))
    && Array.isArray(item.bodies) && item.bodies.every((assignment) => record(assignment)
      && record(assignment.body) && geometry(assignment.body) && assignment.body.kind === "body"
      && (assignment.role === "workpiece" || assignment.role === "stock" || assignment.role === "fixture"));
  const profile = (item: unknown) => record(item)
    && (item.csys === undefined || item.csys === "world" || item.csys === "sketch"
      || (typeof item.csys === "string" && item.csys.startsWith("datum:") && item.csys.length > 6))
    && (item.side === undefined || item.side === "inside" || item.side === "outside")
    && (item.direction === undefined || item.direction === "cw" || item.direction === "ccw")
    && ["diameter", "depth", "clearance", "feed", "plungeFeed", "spindleRpm"].every((key) =>
      item[key] === undefined || typeof item[key] === "string");

  const expressionTriple = (item: unknown) => Array.isArray(item) && item.length === 3
    && item.every((expr) => typeof expr === "string");
  const vector = (item: unknown): item is [number, number, number] =>
    Array.isArray(item) && item.length === 3 && item.every(Number.isFinite);
  const rigidTransform = (item: unknown) => {
    if (!record(item) || !vector(item.origin) || !vector(item.xDir) || !vector(item.yDir) || !vector(item.normal)) return false;
    const [x, y, z] = [item.xDir, item.yDir, item.normal];
    const cross = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    return [x, y, z].every((axis) => Math.abs(Math.hypot(...axis) - 1) < 1e-8)
      && cross.every((value, index) => Math.abs(value - z[index]!) < 1e-8);
  };
  const ids = new Set<string>();
  const numbers = new Set<number>();
  const owned = new Set<string>();
  const uniqueId = (id: unknown, set: Set<string>): id is string => {
    if (typeof id !== "string" || !id.trim() || set.has(id)) return false;
    set.add(id);
    return true;
  };
  const toolPosition = (item: unknown) => {
    if (!record(item) || !uniqueId(item.id, ids) || typeof item.number !== "number"
      || !Number.isSafeInteger(item.number) || item.number < 1 || numbers.has(item.number)) return false;
    numbers.add(item.number);
    return typeof item.name === "string" && !!item.name.trim() && uniqueId(item.tipCsysId, owned)
      && (item.placement === undefined || (record(item.placement) && expressionTriple(item.placement.position) && expressionTriple(item.placement.rotation)))
      && Array.isArray(item.components) && item.components.every((component) => record(component)
        && uniqueId(component.bodyId, owned) && CAM_TOOL_COMPONENT_ROLES.includes(component.role as CamToolComponentRole)
        && (component.sourceToTip === undefined || (item.placement === undefined && rigidTransform(component.sourceToTip))))
      && (item.cuttingBodyId === undefined || item.components.some((component) =>
        component.bodyId === item.cuttingBodyId && canCut(component.role)))
      && (item.profileDiameter === undefined || (typeof item.profileDiameter === "number"
        && Number.isFinite(item.profileDiameter) && item.profileDiameter > 0))
      && (item.cutting === undefined || (record(item.cutting) && item.cutting.kind === "flat-endmill"
        && typeof item.cutting.diameter === "number" && Number.isFinite(item.cutting.diameter) && item.cutting.diameter > 0));
  };

  return record(value) && value.schemaVersion === 1 && typeof value.name === "string"
    && (value.toolPositions === undefined || (Array.isArray(value.toolPositions) && value.toolPositions.every(toolPosition)))
    && (value.tooling === undefined || record(value.tooling))
    && Array.isArray(value.setups) && value.setups.every((item) => record(item)
      && typeof item.id === "string" && typeof item.name === "string"
      && (item.part === undefined || geometry(item.part))
      && (item.contexts === undefined ? geometry(item.part) : Array.isArray(item.contexts) && item.contexts.every(context)))
    && Array.isArray(value.processes) && value.processes.every((item) => record(item)
      && typeof item.id === "string" && typeof item.name === "string" && typeof item.setupId === "string"
      && (item.contextId === undefined || typeof item.contextId === "string")
      && (item.toolPositionId === undefined || (typeof item.toolPositionId === "string" && !!item.toolPositionId.trim()))
      && (item.kind === "profile" || item.kind === "pocket" || item.kind === "adaptive") && (item.contour === undefined || geometry(item.contour))
      && [item.boundaryEdges, item.islandEdges].every((refs) => refs === undefined
        || (Array.isArray(refs) && refs.length <= 500 && refs.every(edge)))
      && (item.floorFace === undefined || floor(item.floorFace))
      && (item.islandSketches === undefined || (item.kind !== "profile" && Array.isArray(item.islandSketches)
        && item.islandSketches.every((ref) => geometry(ref) && record(ref) && ref.kind === "sketch")))
      && (item.profile === undefined || profile(item.profile))
      && (item.contourMilling === undefined || (record(item.contourMilling)
        && (item.contourMilling.side === "center" || item.contourMilling.side === "left" || item.contourMilling.side === "right")
        && (item.contourMilling.direction === "forward" || item.contourMilling.direction === "reverse")
        && typeof item.contourMilling.depth === "string" && typeof item.contourMilling.clearance === "string"
        && [item.contourMilling.stepdown, item.contourMilling.leadIn, item.contourMilling.leadOut]
          .every((value) => value === undefined || typeof value === "string")))
      && (item.kind !== "profile" ? (item.profile === undefined && item.contourMilling === undefined && record(item.pocketMilling)
        && typeof item.pocketMilling.depth === "string" && typeof item.pocketMilling.clearance === "string"
        && typeof item.pocketMilling.stepover === "string"
        && (item.pocketMilling.stepdown === undefined || typeof item.pocketMilling.stepdown === "string")
        && (item.pocketMilling.entry === undefined || (item.kind === "adaptive"
          && (item.pocketMilling.entry === "plunge" || item.pocketMilling.entry === "helix")))
        && (item.pocketMilling.stayDown === undefined || (item.kind === "adaptive" && typeof item.pocketMilling.stayDown === "boolean"))
        && [item.pocketMilling.helixDiameter, item.pocketMilling.rampAngle]
          .every((value) => value === undefined || (item.kind === "adaptive" && typeof value === "string")))
        : item.pocketMilling === undefined)
      && (item.track === undefined || (record(item.track)
        && typeof item.track.id === "string" && typeof item.track.unitId === "string")))
    && (value.processPlan === undefined || (Array.isArray(value.processPlan) && value.processPlan.every((item) =>
      record(item) && (item.kind === "process"
        ? typeof item.processId === "string" && (item.stage === "main" || item.stage === "sub")
        : (item.kind === "transfer" || item.kind === "ejection")
          && typeof item.id === "string" && typeof item.setupId === "string"))));
}
