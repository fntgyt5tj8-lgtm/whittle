import { describe, expect, it } from "vitest";
import { activePlanEnd, addOperationFolder, pastePlannedOperations, deletePlannedOperation, movePlannedOperation, moveTimelineItems, plannedOperations, rollBackPlan, addPlanStage, addProcess, addSetup, createProject, getProcessPlan, migrateWorkpieceContexts, validateProject, type CamSetup } from "../src";
import { isCamProject } from "../src/validation";

const setup: CamSetup = {
  id: "setup-1",
  name: "Setup 1",
  part: { documentId: "document-1", kind: "sketch", entityId: "sketch-1" },
};
const profile = { id: "profile-1", name: "Profile 1", setupId: setup.id, kind: "profile" } as const;

describe("CAM project", () => {
  it("builds a JSON project without changing earlier drafts", () => {
    const draft = createProject("Bracket");
    const prepared = addSetup(draft, setup);
    const project = addProcess(prepared, profile);

    expect(draft.setups).toEqual([]);
    expect(prepared.processes).toEqual([]);
    expect(JSON.parse(JSON.stringify(project))).toEqual(project);
    expect(validateProject(project)).toEqual([]);
  });

  it("pastes at rollback and keeps folders independent of operation order", () => {
    const second = { ...profile, id: "profile-2" };
    const copy = { ...profile, id: "profile-copy" };
    const project = addProcess(addProcess(addSetup(createProject("Job"), setup), profile), second);
    const pasted = pastePlannedOperations(rollBackPlan(project, 1), [{ stage: "sub", operation: copy }]);
    expect(plannedOperations(pasted)).toEqual([profile, copy]);
    expect(getProcessPlan(pasted)[1]).toEqual({ kind: "process", processId: copy.id, stage: "sub" });
    const folder = { id: "folder", name: "Cutting", open: false, operationIds: [copy.id, second.id] };
    const grouped = addOperationFolder(pasted, folder);
    expect(plannedOperations(grouped)).toEqual([profile, copy]);
    expect(isCamProject(JSON.parse(JSON.stringify(grouped)))).toBe(true);
    expect(validateProject(grouped)).toEqual([]);
    const regrouped = addOperationFolder(grouped, { ...folder, id: "other", operationIds: [copy.id] });
    expect(regrouped.operationFolders?.map(({ operationIds }) => operationIds)).toEqual([[second.id], [copy.id]]);
    expect(deletePlannedOperation(deletePlannedOperation(grouped, copy.id), second.id).operationFolders).toEqual([]);
  });

  it("moves a folder as a block in plan order and retains rollback", () => {
    const second = { ...profile, id: "profile-2" };
    const third = { ...profile, id: "profile-3" };
    const project = [profile, second, third].reduce(addProcess, addSetup(createProject("Job"), setup));
    const grouped = addOperationFolder(rollBackPlan(project, 2), {
      id: "folder", name: "Finishing", open: false, operationIds: [third.id, second.id],
    });
    const moved = moveTimelineItems(grouped, { folderId: "folder" }, { operationId: profile.id, side: "before" });
    expect(plannedOperations(moved)).toEqual([second, third]);
    expect(activePlanEnd(moved)).toBe(2);
    expect(moved.operationFolders).toBe(grouped.operationFolders);
    expect(moveTimelineItems(moved, { folderId: "folder" }, { operationId: profile.id, side: "after" }).processPlan)
      .toEqual(grouped.processPlan);
  });

  it("updates folder membership and operation order together", () => {
    const second = { ...profile, id: "profile-2" };
    const third = { ...profile, id: "profile-3" };
    const project = [profile, second, third].reduce(addProcess, addSetup(createProject("Job"), setup));
    const grouped = addOperationFolder(addOperationFolder(project, {
      id: "roughing", name: "Roughing", open: true, operationIds: [profile.id],
    }), { id: "finishing", name: "Finishing", open: false, operationIds: [third.id] });
    const inserted = moveTimelineItems(grouped, { operationId: profile.id }, {
      operationId: third.id, side: "after", folderId: "finishing",
    });
    expect(plannedOperations(inserted)).toEqual([second, third, profile]);
    expect(inserted.operationFolders).toEqual([
      { id: "finishing", name: "Finishing", open: false, operationIds: [third.id, profile.id] },
    ]);

    const detached = moveTimelineItems(inserted, { operationId: profile.id }, { operationId: profile.id, side: "after" });
    expect(detached.processPlan).toBe(inserted.processPlan);
    expect(detached.operationFolders?.[0]?.operationIds).toEqual([third.id]);
  });

  it("rejects crossing stage and setup boundaries when dragging timeline items", () => {
    const otherSetup = { ...setup, id: "other-setup" };
    const second = { ...profile, id: "profile-2" };
    const third = { ...profile, id: "profile-3", setupId: otherSetup.id };
    const transfer = { id: "transfer", kind: "transfer", setupId: setup.id } as const;
    const draft = addSetup(addSetup(createProject("Job"), setup), otherSetup);
    const project = addProcess(addProcess(addPlanStage(addProcess(draft, profile), transfer), second), third);
    const grouped = addOperationFolder(project, {
      id: "folder", name: "Finishing", open: false, operationIds: [second.id],
    });
    expect(moveTimelineItems(grouped, { folderId: "folder" }, { operationId: profile.id, side: "before" })).toBe(grouped);
    expect(moveTimelineItems(grouped, { operationId: third.id }, {
      operationId: second.id, side: "after", folderId: "folder",
    })).toBe(grouped);
  });

  it("preserves part order independently of execution track assignments", () => {
    const first = { ...profile, track: { unitId: "unit-1", id: "track-2" } };
    const second = { ...profile, id: "profile-2", track: { unitId: "unit-1", id: "track-1" } };
    const transfer = { id: "transfer-1", kind: "transfer", setupId: setup.id } as const;
    const ejection = { id: "ejection-1", kind: "ejection", setupId: setup.id } as const;
    const draft = addSetup(createProject("Bracket"), setup);
    const project = addPlanStage(addProcess(addPlanStage(addProcess(draft, first), transfer), second), ejection);

    expect(getProcessPlan(project)).toEqual([
      { kind: "process", processId: first.id, stage: "main" },
      transfer,
      { kind: "process", processId: second.id, stage: "main" },
      ejection,
    ]);
    expect(project.processes).toEqual([first, second]);
    expect(validateProject(project)).toEqual([]);
  });

  it("retains older drafts that have operations without an explicit part plan", () => {
    const draft = { schemaVersion: 1, name: "Bracket", setups: [setup], processes: [profile] } as const;
    const stage = { id: "ejection-1", kind: "ejection", setupId: setup.id } as const;

    expect(validateProject(draft)).toEqual([]);
    expect(getProcessPlan(addPlanStage(draft, stage))).toEqual([
      { kind: "process", processId: profile.id, stage: "main" },
      stage,
    ]);
  });

  it("validates explicit plan references", () => {
    const draft = addProcess(addSetup(createProject("Bracket"), setup), profile);
    const project = {
      ...draft,
      processPlan: [
        { kind: "process", processId: "missing", stage: "main" },
        { kind: "transfer", id: "transfer-1", setupId: "missing" },
      ],
    } as const;

    expect(validateProject(project)).toEqual([
      "Each planned operation needs an existing process.",
      "Each plan stage needs an existing setup.",
      "Each process needs a plan entry.",
    ]);
  });

  it("reports duplicate IDs and missing setup references", () => {
    const draft = addSetup(addSetup(createProject("Bracket"), setup), setup);
    const project = addProcess(draft, { ...profile, setupId: "missing" });

    expect(validateProject(project)).toEqual([
      "Setup IDs must be present and unique.",
      "Each process needs an existing setup.",
    ]);
  });
});

describe("Manufacturing history", () => {
  const first = { ...profile, profile: { depth: "2" }, track: { unitId: "unit-1", id: "track-2" } };
  const second = { ...profile, id: "profile-2", suppressed: true };
  const third = { ...profile, id: "profile-3" };
  const otherSetup = { ...setup, id: "setup-2" };
  const other = { ...profile, id: "profile-4", setupId: otherSetup.id };
  const draft = {
    ...createProject("Bracket"), setups: [setup, otherSetup], processes: [first, second, third, other], processPlan: undefined,
  };

  it("uses matching plan order and keeps operation identity and settings", () => {
    const reordered = movePlannedOperation(draft, third.id, first.id);
    expect(plannedOperations(reordered, setup.id)).toEqual([third, first]);
    expect(reordered.processes).toBe(draft.processes);
    expect(reordered.setups).toBe(draft.setups);
    expect(plannedOperations(reordered, otherSetup.id)).toEqual([other]);
    expect(movePlannedOperation(reordered, first.id, other.id)).toBe(reordered);

    const transfer = { kind: "transfer", id: "transfer", setupId: setup.id } as const;
    const plan = getProcessPlan(reordered);
    const withTransfer = { ...reordered, processPlan: [plan[0]!, transfer, ...plan.slice(1)] };
    expect(movePlannedOperation(withTransfer, first.id, third.id)).toBe(withTransfer);
  });

  it("persists suppression and rollback, and adjusts the marker when deleting", () => {
    const rolledBack = rollBackPlan(draft, 3);
    const saved = JSON.parse(JSON.stringify(rolledBack));
    expect(isCamProject(saved)).toBe(true);
    expect(isCamProject({ ...saved, planRollback: -1 })).toBe(false);
    expect(isCamProject({ ...saved, processes: [{ ...first, suppressed: "yes" }] })).toBe(false);
    expect(activePlanEnd(saved)).toBe(3);
    expect(plannedOperations(saved)).toEqual([first, third]);
    const deleted = deletePlannedOperation(saved, first.id);
    expect(activePlanEnd(deleted)).toBe(2);
    expect(plannedOperations(deleted)).toEqual([third]);
    expect(validateProject(deleted)).toEqual([]);
    expect(plannedOperations(rollBackPlan(deleted, 3))).toEqual([third, other]);
    expect(plannedOperations(rollBackPlan(deleted, 0))).toEqual([]);
  });
});

describe("Phase 01 workpiece migration", () => {
  it("groups matching frames and retains distinct sketch origins and native IDs", () => {
    const body = { documentId: "document-1", kind: "body", entityId: "stock" } as const;
    const contour = setup.part;
    const legacy = {
      ...createProject("Bracket"),
      setups: [{ ...setup, part: body }],
      processPlan: undefined,
      processes: [
        { ...profile, id: "world" },
        { ...profile, id: "also-world", profile: { csys: "world", depth: "2" } },
        { ...profile, id: "sketch", contour, profile: { csys: "sketch" } },
        { ...profile, id: "other-sketch", contour: { ...contour!, entityId: "sketch-2" }, profile: { csys: "sketch" } },
        { ...profile, id: "datum", profile: { csys: "datum:fixture", side: "inside" } },
      ],
    } as const;
    const migrated = migrateWorkpieceContexts(legacy);
    const migratedSetup = migrated.setups[0]!;
    const contexts = migratedSetup.contexts!;
    const [world, sketch, otherSketch, datum] = contexts;
    expect(contexts.map(({ frame }) => frame)).toEqual([
      { kind: "legacy-world" }, { kind: "legacy-sketch", sketch: contour },
      { kind: "legacy-sketch", sketch: legacy.processes[3].contour }, { kind: "native", csysId: "fixture" },
    ]);
    expect(contexts.every(({ bodies }) => bodies[0]?.body.entityId === body.entityId)).toBe(true);
    expect(migrated.processes.map(({ contextId }) => contextId)).toEqual([
      world?.id, world?.id, sketch?.id, otherSketch?.id, datum?.id,
    ]);
    expect(migrated.processes[1]?.profile).toEqual({ depth: "2" });
    expect(migrated.processes[4]?.profile).toEqual({ side: "inside" });
    expect(getProcessPlan(migrated)).toEqual(getProcessPlan(legacy));
    expect(migrateWorkpieceContexts(migrated)).toBe(migrated);
    expect(validateProject(migrated)).toEqual([]);
    expect(validateProject({ ...migrated, setups: [{ ...migratedSetup, contexts: contexts.slice(0, 3) }] }))
      .toContain("Profile 1 needs an existing workpiece context in its setup.");
  });
});
