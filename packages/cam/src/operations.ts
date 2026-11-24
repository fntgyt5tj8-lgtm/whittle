import type { CamContextFrame, CamExecutionTrack, CamMachiningStage, CamOperationFolder, CamWorkpieceContext, CamPlanItem, CamPlanStage, CamProcess, CamProject, CamSetup } from "./model";

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

export type TimelineDragSource = { operationId: string } | { folderId: string };
export type TimelineDropTarget = {
  operationId?: string;
  side: "before" | "after";
  folderId?: string;
  track?: { setupId: string; id: string };
};

const defaultTracks: readonly CamExecutionTrack[] = [{ id: "default", name: "Track 1" }];

export function executionTracks(setup: CamSetup): readonly CamExecutionTrack[] {
  return setup.executionTracks?.length ? setup.executionTracks : defaultTracks;
}

export function executionTrackId(setup: CamSetup, trackId?: string): string {
  const tracks = executionTracks(setup);
  return tracks.find(({ id }) => id === trackId)?.id ?? tracks[0]!.id;
}

function timelineTarget(project: CamProject, target: TimelineDropTarget) {
  const anchor = project.processes.find(({ id }) => id === target.operationId);
  const setup = project.setups.find(({ id }) => id === (target.track?.setupId ?? anchor?.setupId));
  if (!setup || (target.operationId !== undefined && anchor?.setupId !== setup.id)
    || (target.track && !executionTracks(setup).some(({ id }) => id === target.track?.id))) return;
  const plan = getProcessPlan(project);
  const index = plan.findIndex((item) => item.kind === "process" && item.processId === target.operationId);
  const entry = plan[index];
  if (target.operationId !== undefined && (entry?.kind !== "process" || (target.track
    && executionTrackId(setup, entry.trackId) !== target.track.id))) return;
  if (target.folderId && !project.operationFolders?.some(({ id, operationIds }) =>
    id === target.folderId && target.operationId !== undefined && operationIds.includes(target.operationId))) return;
  return { setup, plan, index };
}

export function insertTimelineOperation(project: CamProject, process: CamProcess, target: TimelineDropTarget): CamProject {
  const destination = timelineTarget(project, target);
  if (!destination || destination.setup.id !== process.setupId) return project;
  const { plan, index } = destination;
  const boundary = index < 0 ? plan.length : index + Number(target.side === "after");
  const end = activePlanEnd(project);
  const operation: CamPlanItem = {
    kind: "process", processId: process.id, stage: "main",
    trackId: target.track?.id,
  };
  let updated = rollBackPlan({
    ...project, processes: [...project.processes, process],
    processPlan: [...plan.slice(0, boundary), operation, ...plan.slice(boundary)],
  }, end + Number(project.planRollback === undefined || boundary < end));
  if (target.folderId) {
    updated = { ...updated, operationFolders: updated.operationFolders?.map((folder) =>
      folder.id === target.folderId ? { ...folder, operationIds: [...folder.operationIds, process.id] } : folder) };
  }
  return updated;
}

/** Apply the order and membership change together so one undo restores both. */
export function moveTimelineItems(project: CamProject, source: TimelineDragSource, target: TimelineDropTarget): CamProject {
  const folders = project.operationFolders ?? [];
  const movingFolder = "folderId" in source;
  const ids = movingFolder
    ? folders.find(({ id }) => id === source.folderId)?.operationIds
    : [source.operationId];
  const destination = folders.find(({ id }) => id === target.folderId);
  if (!ids?.length || (target.folderId && (!target.operationId || !destination?.operationIds.includes(target.operationId) || movingFolder))) {
    return project;
  }

  const resolved = timelineTarget(project, target);
  if (!resolved || (movingFolder && target.operationId && ids.includes(target.operationId))
    || (resolved.index < 0 && !target.track)) return project;
  const { plan, index: targetIndex, setup } = resolved;
  const setupId = setup.id;
  if (!setupId || ids.some((id) => !project.processes.some((item) => item.id === id && item.setupId === setupId))) return project;
  const boundary = targetIndex + (target.side === "after" ? 1 : 0);
  const movingIds = new Set(ids);
  const moved = plan.filter((item) => item.kind === "process" && movingIds.has(item.processId));
  if (moved.length !== movingIds.size) return project;

  let insertionIndex = boundary;
  for (const id of targetIndex < 0 ? [] : movingIds) {
    const from = plan.findIndex((item) => item.kind === "process" && item.processId === id);
    if (from < boundary) insertionIndex--;
    // The operation immediately across the insertion boundary is untouched.
    const crossed = plan[from < boundary ? boundary - 1 : boundary];
    if (crossed?.kind !== "process" || planMoveProblem(project, id, crossed.processId)) return project;
  }

  // An empty destination changes ownership without shifting the existing global plan.
  const reordered = targetIndex < 0 ? [...plan] : plan.filter((item) => item.kind !== "process" || !movingIds.has(item.processId));
  if (targetIndex >= 0) reordered.splice(insertionIndex, 0, ...moved);
  if (target.track) {
    const trackId = target.track.id;
    for (const [index, item] of reordered.entries()) {
      if (item.kind === "process" && movingIds.has(item.processId) && executionTrackId(setup, item.trackId) !== trackId) {
        reordered[index] = { ...item, trackId };
      }
    }
  }
  const orderChanged = reordered.some((item, index) => item !== plan[index]);
  const membershipChanged = "operationId" in source
    && folders.find((folder) => folder.operationIds.includes(source.operationId)) !== destination;
  if (!orderChanged && !membershipChanged) return project;

  let updated = orderChanged ? { ...project, processPlan: reordered } : project;
  if (membershipChanged && "operationId" in source) {
    updated = {
      ...updated,
      operationFolders: folders.flatMap((folder) => {
        if (folder === destination) return [{ ...folder, operationIds: [...folder.operationIds, source.operationId] }];
        const operationIds = folder.operationIds.filter((id) => id !== source.operationId);
        if (operationIds.length === folder.operationIds.length) return [folder];
        return operationIds.length ? [{ ...folder, operationIds }] : [];
      }),
    };
  }
  return updated;
}

export function pastePlannedOperations(
  project: CamProject, copies: readonly { operation: CamProcess; stage: CamMachiningStage; trackId?: string }[],
  at = activePlanEnd(project),
): CamProject {
  if (!copies.length) return project;
  const end = activePlanEnd(project);
  const plan = getProcessPlan(project);
  const boundary = Math.max(0, Math.min(at, plan.length));
  return rollBackPlan({
    ...project,
    processes: [...project.processes, ...copies.map(({ operation }) => operation)],
    processPlan: [
      ...plan.slice(0, boundary),
      ...copies.map(({ operation, stage, trackId }) => ({ kind: "process" as const, processId: operation.id, stage, trackId })),
      ...plan.slice(boundary),
    ],
  }, end + (boundary <= end ? copies.length : 0));
}

/** Move these operations out of their old folders and into a new folder. */
export function addOperationFolder(project: CamProject, folder: CamOperationFolder): CamProject {
  const ids = new Set(folder.operationIds);
  return { ...project, operationFolders: [...withoutFolderMembers(project, ids), folder] };
}

function withoutFolderMembers(project: CamProject, ids: ReadonlySet<string>) {
  return (project.operationFolders ?? []).map((folder) => ({
    ...folder, operationIds: folder.operationIds.filter((id) => !ids.has(id)),
  })).filter((folder) => folder.operationIds.length);
}

export function deletePlannedOperation(project: CamProject, id: string): CamProject {
  if (!project.processes.some((item) => item.id === id)) return project;
  const plan = getProcessPlan(project);
  const keep = (item: CamPlanItem) => item.kind !== "process" || item.processId !== id;
  const end = plan.slice(0, activePlanEnd(project)).filter(keep).length;
  return rollBackPlan({
    ...project, operationFolders: project.operationFolders && withoutFolderMembers(project, new Set([id])),
    processPlan: plan.filter(keep), processes: project.processes.filter((item) => item.id !== id),
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
