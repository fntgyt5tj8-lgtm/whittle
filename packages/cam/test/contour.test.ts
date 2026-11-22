import { describe, expect, it } from "vitest";
import { CAM_WORLD, generateContour, type CamFrame, type ContourCurve, type ContourMillingSettings } from "../src";

const line = (a: [number, number], b: [number, number]): ContourCurve => ({ kind: "line", a, b });
const settings: ContourMillingSettings = { side: "left", direction: "forward", depth: "1", clearance: "2" };
const square = [line([0, 0], [4, 0]), line([4, 0], [4, 4]), line([4, 4], [0, 4]), line([0, 4], [0, 0])];
const quarterArc: ContourCurve = { kind: "arc", c: [4, 2], r: 2, start: -Math.PI / 2, sweep: Math.PI / 2 };

function generate(curves: ContourCurve[], options: Partial<ContourMillingSettings> = {}, diameter = 1,
  sketch = CAM_WORLD, setup = CAM_WORLD) {
  return generateContour(curves, sketch, setup, { ...settings, ...options }, diameter);
}

function path(curves: ContourCurve[], options: Partial<ContourMillingSettings> = {}, diameter = 1,
  sketch = CAM_WORLD, setup = CAM_WORLD) {
  const result = generate(curves, options, diameter, sketch, setup);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.value;
}

describe("2.5D contour milling", () => {
  it("uses the cutter radius on either side relative to forward and reverse travel", () => {
    const open = [line([0, 0], [4, 0])];
    expect(path(open).centerline).toEqual([[0, 0.5, -1], [4, 0.5, -1]]);
    expect(path(open, { side: "right" }).centerline).toEqual([[0, -0.5, -1], [4, -0.5, -1]]);
    expect(path(open, { direction: "reverse" }).centerline).toEqual([[4, -0.5, -1], [0, -0.5, -1]]);
    expect(path(open, { direction: "reverse", side: "right" }).centerline).toEqual([[4, 0.5, -1], [0, 0.5, -1]]);
    const onCenter = path(open, { side: "center" });
    expect(onCenter.programmed).toEqual([[0, 0, 0], [4, 0, 0]]);
    expect(onCenter.linkingMoves).toEqual([[[0, 0, 2], [0, 0, -1]], [[4, 0, -1], [4, 0, 2]]]);
    expect(onCenter.pointAt(0.5)).toEqual([2, 0, -1]);
  });

  it("trims inside corners and rounds outside corners with the cutter radius", () => {
    expect(path(square).centerline).toEqual([[0.5, 0.5, -1], [3.5, 0.5, -1], [3.5, 3.5, -1],
      [0.5, 3.5, -1], [0.5, 0.5, -1]]);
    const outside = path(square, { side: "right" });
    expect(outside.length).toBeCloseTo(16 + Math.PI + 6);
    expect(outside.centerline.slice(1, 5).every(([x, y]) => Math.abs(Math.hypot(x - 4, y) - 0.5) < 1e-8)).toBe(true);
  });

  it("preserves analytic circular and mixed line/arc offsets, including reversed sweeps", () => {
    const open = [line([0, 0], [4, 0]), quarterArc];
    const cut = path(open);
    expect(cut.length).toBeCloseTo(4 + Math.PI * 0.75 + 6);
    expect(cut.pointAt((3 + 4 + Math.PI * 0.375) / cut.length)[0]).toBeCloseTo(4 + Math.SQRT1_2 * 1.5);
    const reversed = path(open, { direction: "reverse" });
    expect(reversed.pointAt(0)[0]).toBeCloseTo(6.5);
    expect(reversed.length).toBeCloseTo(4 + Math.PI * 1.25 + 6);
    const circle = { ...quarterArc, sweep: 2 * Math.PI };
    expect(path([circle]).length).toBeCloseTo(3 * Math.PI + 6);
    // An inside line/arc corner is trimmed at the two offset supports.
    const sharpJoin = path([line([4, 2], [4, 0]), quarterArc], { side: "left" });
    expect(sharpJoin.centerline[1]![0]).toBeCloseTo(4.5);
    expect(sharpJoin.centerline[1]![1]).toBeCloseTo(2 - Math.sqrt(2));
  });

  it("cuts exact depth passes with tangent leads and clearance-only lateral rapids", () => {
    const cut = path([line([0, 0], [4, 0])], { depth: "2.5", stepdown: "1", leadIn: "1", leadOut: "2" });
    expect(cut.cuttingPasses).toEqual([-1, -2, -2.5].map((z) => [
      [-1, 0.5, z], [0, 0.5, z], [4, 0.5, z], [6, 0.5, z],
    ]));
    expect(cut.motions.filter((motion) => motion.kind === "line").map((motion) => motion.mode)).toEqual([
      "plunge", "feed", "feed", "feed", "rapid", "rapid",
      "plunge", "feed", "feed", "feed", "rapid", "rapid",
      "plunge", "feed", "feed", "feed", "rapid",
    ]);
    expect(cut.linkingMoves[2]).toEqual([[6, 0.5, 2], [-1, 0.5, 2]]);
    expect(cut.pointAt(0)).toEqual([-1, 0.5, 2]);
    expect(cut.pointAt(1)).toEqual([6, 0.5, 2]);
    expect(cut.pointAt(16 / cut.length)).toEqual([3, 0.5, 2]);
    for (const [i, motion] of cut.motions.entries()) {
      if (i > 0) expect(motion.start).toEqual(cut.motions[i - 1]!.end);
    }
  });

  it("emits full-circle arcs with distinct endpoints and repeats a closed contour at each depth", () => {
    const circle = { ...quarterArc, sweep: 2 * Math.PI };
    const cut = path([circle], { side: "right", direction: "reverse", depth: "0.14", stepdown: "0.01" });
    expect(cut.cuttingPasses).toHaveLength(14);
    expect(cut.centerline[0]![2]).toBe(-0.14);
    const arcs = cut.motions.filter((motion) => motion.kind === "arc");
    expect(arcs).toHaveLength(28);
    expect(arcs.every((arc) => arc.direction === "cw" && Math.hypot(
      arc.end[0] - arc.start[0], arc.end[1] - arc.start[1],
    ) > 2.99)).toBe(true);
    expect(path(square, { depth: "2", stepdown: "1" }).linkingMoves).toHaveLength(4);
    expect(cut.linkingMoves).toHaveLength(28);
  });

  it("rejects leads that gouge corners or cross an open chain", () => {
    expect(generate(square, { leadIn: "0.25" })).toMatchObject({ ok: false, errors: [expect.stringContaining("Lead-in")] });
    const folded = [line([0, 0], [4, 0]), line([4, 0], [4, 2]), line([4, 2], [-1, 2]), line([-1, 2], [-1, -1])];
    expect(generate(folded, { side: "center", leadIn: "2" }).ok).toBe(false);
    expect(generate(square, { leadOut: "-1" }).ok).toBe(false);
    expect(generate(square, { stepdown: "0" }).ok).toBe(false);
    expect(generate(square, { stepdown: "0.00001" }).ok).toBe(false);
    expect(path(square, { stepdown: "", leadOut: "0" }).cuttingPasses).toHaveLength(1);
  });

  it("trims or rounds an arc-to-arc corner on the selected side", () => {
    const a: ContourCurve = { kind: "arc", c: [0, 0], r: 4, start: -Math.PI / 2, sweep: Math.PI / 2 };
    const b: ContourCurve = { kind: "arc", c: [4, 4], r: 4, start: -Math.PI / 2, sweep: Math.PI / 2 };
    const inner = path([a, b], { side: "right" }).motions.filter((motion) => motion.kind === "arc");
    expect(inner).toHaveLength(2);
    expect(inner[0]!.end[0]).toBeCloseTo(inner[1]!.start[0]);
    expect(inner[0]!.end[1]).toBeCloseTo(inner[1]!.start[1]);
    const outer = path([a, b]).motions.filter((motion) => motion.kind === "arc");
    expect(outer).toHaveLength(3);
    expect(outer[1]).toMatchObject({ kind: "arc", direction: "cw", center: [4, 0, -1] });
    expect(path([a, b], { side: "right", direction: "reverse" }).length).toBeCloseTo(path([a, b]).length);
  });

  it("handles rotated and translated sketch and setup axes and refuses a tilted sketch", () => {
    const sketch: CamFrame = { origin: [3, 5, 7], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] };
    const setup: CamFrame = { origin: [1, 2, 3], x: [0, 0, 1], y: [0, -1, 0], z: [1, 0, 0] };
    const curves = [line([0, 0], [4, 0])];
    expect(path(curves, {}, 1, sketch, setup).centerline).toEqual([[2, 5, 7.5], [2, 9, 7.5]]);
    expect(generate(curves, {}, 1, sketch).ok).toBe(false);
  });

  it("rejects disconnected, branched, crossing and collapsed paths and invalid machining values", () => {
    for (const bad of [
      [line([0, 0], [1, 0]), line([2, 0], [3, 0])],
      [line([0, 0], [1, 0]), line([1, 0], [2, 0]), line([1, 0], [1, 1])],
      [line([0, 0], [2, 2]), line([2, 2], [0, 2]), line([0, 2], [2, 0])],
      [line([0, 0], [2, 0]), line([2, 0], [0, 0])],
    ]) expect(generate(bad).ok).toBe(false);
    expect(generate(square, {}, 4).ok).toBe(false);
    expect(generate([quarterArc], {}, 4).ok).toBe(false);
    expect(generate(square, {}, Number.NaN).ok).toBe(false);
    expect(generate(square, { depth: "" }).ok).toBe(false);
    expect(generate(square, { clearance: "-1" }).ok).toBe(false);
  });
});
