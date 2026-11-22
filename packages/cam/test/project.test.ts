import { describe, expect, it } from "vitest";
import { addPlanStage, addProcess, addSetup, createProject, getProcessPlan, validateProject, type CamSetup } from "../src";

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
