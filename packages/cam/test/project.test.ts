import { describe, expect, it } from "vitest";
import { activePlanEnd, deletePlannedOperation, movePlannedOperation, plannedOperations, rollBackPlan, addPlanStage, addProcess, addSetup, createProject, getProcessPlan, migrateWorkpieceContexts, validateProject, type CamSetup } from "../src";
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
