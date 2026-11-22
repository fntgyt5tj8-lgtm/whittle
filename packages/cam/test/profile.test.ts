import { describe, expect, it } from "vitest";
import {
  CAM_WORLD, exportAptCl, generateCircularProfile, transformCamVector, validateToolpath,
  type CamFrame, type CircularProfile,
} from "../src";

const tilted: CamFrame = { origin: [10, 20, 30], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] };
const input: CircularProfile = {
  geometry: { center: [2, 3], radius: 8, operationFrame: tilted },
  workpieceCsys: CAM_WORLD,
  tool: { kind: "flat-endmill", diameter: 4 },
  side: "outside", direction: "ccw", depth: 2, clearance: 5, feed: 200, plungeFeed: 50,
};

function path(overrides: Partial<CircularProfile> = {}) {
  const result = generateCircularProfile({ ...input, ...overrides });
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.value;
}

describe("portable circular profile", () => {
  it("transforms points and directions in both directions", () => {
    expect(transformCamVector([2, 3, -2], tilted, CAM_WORLD, "point")).toEqual([8, 22, 33]);
    expect(transformCamVector([8, 22, 33], CAM_WORLD, tilted, "point")).toEqual([2, 3, -2]);
    expect(transformCamVector([0, 0, 1], tilted, CAM_WORLD, "direction")).toEqual([1, 0, 0]);
  });

  it("offsets outside the contour and retains four true arcs in the workpiece frame", () => {
    const { motions } = path();
    expect(motions.map((move) => move.kind)).toEqual(["line", "arc", "arc", "arc", "arc", "line"]);
    expect(motions[0]).toMatchObject({ start: [15, 32, 33], end: [8, 32, 33], mode: "plunge" });
    expect(motions[1]).toMatchObject({
      center: [8, 22, 33], normal: [1, 0, 0], direction: "ccw", end: [8, 22, 43],
    });
    expect(motions[4]?.end).toEqual(motions[0]?.end);
    expect(motions[5]).toMatchObject({ end: [15, 32, 33], mode: "rapid" });
    expect(motions.every((move) => move.toolAxis.join(",") === "1,0,0")).toBe(true);
  });

  it("exports a clockwise inside profile in sketch coordinates deterministically", () => {
    const toolpath = path({ side: "inside", direction: "cw", workpieceCsys: tilted });
    const apt = exportAptCl(toolpath);
    expect(apt).toEqual(exportAptCl(toolpath));
    expect(apt).toEqual({ ok: true, value: [
      "UNITS/MM", "MULTAX/ON", "CUTTER/4", "FROM/8,3,5,0,0,1", "FEDRAT/50,MMPM",
      "GOTO/8,3,-2,0,0,1", "FEDRAT/200,MMPM",
      "CIRCLE/2,3,-2,0,0,-1,6", "GOTO/2,-3,-2,0,0,1",
      "CIRCLE/2,3,-2,0,0,-1,6", "GOTO/-4,3,-2,0,0,1",
      "CIRCLE/2,3,-2,0,0,-1,6", "GOTO/2,9,-2,0,0,1",
      "CIRCLE/2,3,-2,0,0,-1,6", "GOTO/8,3,-2,0,0,1",
      "RAPID", "GOTO/8,3,5,0,0,1", "FINI", "",
    ].join("\n") });
  });

  it("formats decimal coordinates and equal arc radii without roundoff tails", () => {
    const apt = exportAptCl(path({
      geometry: { center: [-35, 25], radius: 12.63, operationFrame: CAM_WORLD },
      tool: { kind: "flat-endmill", diameter: 2 },
      side: "inside", depth: 1, clearance: 1, feed: 80, plungeFeed: 80,
    }));
    expect(apt).toEqual({ ok: true, value: [
      "UNITS/MM", "MULTAX/ON", "CUTTER/2", "FROM/-23.37,25,1,0,0,1", "FEDRAT/80,MMPM",
      "GOTO/-23.37,25,-1,0,0,1",
      "CIRCLE/-35,25,-1,0,0,1,11.63", "GOTO/-35,36.63,-1,0,0,1",
      "CIRCLE/-35,25,-1,0,0,1,11.63", "GOTO/-46.63,25,-1,0,0,1",
      "CIRCLE/-35,25,-1,0,0,1,11.63", "GOTO/-35,13.37,-1,0,0,1",
      "CIRCLE/-35,25,-1,0,0,1,11.63", "GOTO/-23.37,25,-1,0,0,1",
      "RAPID", "GOTO/-23.37,25,1,0,0,1", "FINI", "",
    ].join("\n") });
  });

  it("rejects invalid frames, infeasible inside offsets and nonfinite inputs in stable order", () => {
    expect(generateCircularProfile({
      ...input, side: "inside", tool: { kind: "flat-endmill", diameter: 16 },
      workpieceCsys: { ...CAM_WORLD, z: [0, 0, -1] }, depth: 0, feed: Infinity,
    })).toEqual({ ok: false, errors: [
      "Workpiece CSYS must be a finite right-handed orthonormal frame.",
      "Compensated cutter radius must be positive.",
      "Cut depth must be positive.",
      "Cut feed must be positive.",
    ] });
  });

  it("rejects disconnected moves, invalid arc planes and changes in tool axis", () => {
    const original = path();
    const damaged = {
      ...original,
      motions: original.motions.map((motion, i) => i === 1 && motion.kind === "arc"
        ? { ...motion, start: [0, 0, 0] as const, toolAxis: [0, 0, 1] as const }
        : motion),
    };
    expect(validateToolpath(damaged)).toEqual([
      "Motion 2 requires a constant unit tool axis.",
      "Motion 2 is disconnected.",
      "Motion 2 has invalid arc geometry.",
      "Motion 3 requires a constant unit tool axis.",
    ]);
    expect(exportAptCl(damaged).ok).toBe(false);
  });
});
