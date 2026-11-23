import { describe, expect, it } from "vitest";
import { CAM_WORLD, generateFacing, transformCamVector, type CamFrame, type ContourCurve,
  type ContourPoint, type FacingMillingSettings } from "../src";

function polygon(vertices: ContourPoint[]): ContourCurve[] {
  return vertices.map((a, i) => ({ kind: "line", a, b: vertices[(i + 1) % vertices.length]! }));
}

const rectangle = polygon([[0, 0], [20, 0], [20, 9], [0, 9]]);
const concave = polygon([[0, 0], [20, 0], [20, 3], [4, 3], [4, 9], [0, 9]]);
const settings: FacingMillingSettings = { top: "2", depth: "-1", clearance: "3", stepdown: "1.25",
  stepover: "75", strategy: "one-way" };

describe("facing milling", () => {

  it.each([{ boundary: rectangle }, { boundary: concave }])(
    "covers every row and edge of the selected boundary", ({ boundary }) => {
      const result = generateFacing(boundary, CAM_WORLD, CAM_WORLD, settings, 4);
      if (!result.ok) throw new Error(result.errors.join(", "));
      const { motions, cuttingPasses } = result.value;
      const feeds = motions.filter((move) => move.kind === "line" && move.mode === "feed");
      expect([...new Set(feeds.map((move) => move.start[2]))]).toEqual([0.75, -0.5, -1]);
      expect(cuttingPasses).toHaveLength(12);
      for (const [i, { start, end }] of feeds.entries()) {
        expect(start[0]).toBeLessThan(-2);
        expect(end[0]).toBeGreaterThan(22);
        expect(start[1]).toBe((i % 4) * 3);
        expect(end[1]).toBe(start[1]);
      }
      for (const move of motions) {
        if (move.kind === "line" && move.mode === "rapid" && move.start[0] !== move.end[0]) {
          expect([move.start[2], move.end[2]]).toEqual([5, 5]);
        }
      }
    });

  it("uses the full circular extrema and turns outside the cutter envelope", () => {
    const circle: ContourCurve = { kind: "arc", c: [3, 5], r: 3, start: 0.4, sweep: -2 * Math.PI };
    const result = generateFacing([circle], CAM_WORLD, CAM_WORLD, {
      ...settings, strategy: "zigzag", stepdown: "", stepover: "100",
    }, 6);
    if (!result.ok) throw new Error(result.errors.join(", "));
    const [pass] = result.value.cuttingPasses;
    expect(result.value.cuttingPasses).toHaveLength(1);
    expect(pass).toHaveLength(4);
    expect(pass![0]![0]).toBeLessThan(-3);
    expect(pass![1]![0]).toBeGreaterThan(9);
    expect(pass![2]![0]).toBe(pass![1]![0]);
    expect(pass!.map((p) => p[1])).toEqual([2, 2, 8, 8]);
  });

  it("increases spacing and overtravel with inherited cutter diameter", () => {
    const small = generateFacing(rectangle, CAM_WORLD, CAM_WORLD, { ...settings, stepdown: "" }, 2);
    const large = generateFacing(rectangle, CAM_WORLD, CAM_WORLD, { ...settings, stepdown: "" }, 8);
    if (!small.ok || !large.ok) throw new Error("Expected facing previews");
    expect(small.value.cuttingPasses).toHaveLength(7);
    expect(large.value.cuttingPasses).toHaveLength(3);
    expect(large.value.pointAt(0)[0]).toBeLessThan(small.value.pointAt(0)[0]);
  });

  const c = Math.SQRT1_2;
  const side: CamFrame = { origin: [5, 10, 15], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] };
  const tilted: CamFrame = { origin: [5, 10, 15], x: [c, 0, -c], y: [0, 1, 0], z: [c, 0, c] };
  it.each([{ frame: side }, { frame: tilted }])("preserves height and tool axis in indexed machining", ({ frame }) => {
    const result = generateFacing(rectangle, frame, frame, settings, 4, CAM_WORLD);
    if (!result.ok) throw new Error(result.errors.join(", "));
    for (const motion of result.value.motions) {
      motion.toolAxis.forEach((value, i) => expect(value).toBeCloseTo(frame.z[i]!, 12));
      if (motion.kind === "line" && motion.mode === "feed") {
        const height = transformCamVector(motion.end, CAM_WORLD, frame, "point")[2];
        expect([0.75, -0.5, -1].some((value) => Math.abs(value - height) < 1e-8)).toBe(true);
      }
    }
    expect(transformCamVector(result.value.pointAt(0), CAM_WORLD, frame, "point")[2]).toBeCloseTo(5);
  });

  it("rejects unbounded or unsupported requests", () => {
    for (const changes of [{ stepover: "0" }, { stepover: "101" }, { depth: "2" }, { depth: "" },
      { clearance: "-1" }, { stepdown: "0" }, { stepdown: ".0001" }, { stepover: ".0001" }]) {
      expect(generateFacing(rectangle, CAM_WORLD, CAM_WORLD, { ...settings, ...changes }, 4).ok).toBe(false);
    }
    for (const boundary of [rectangle.slice(1), [...rectangle, ...polygon([[1, 1], [2, 1], [2, 2]])],
      polygon([[0, 0], [4, 4], [0, 4], [4, 0]])]) {
      expect(generateFacing(boundary, CAM_WORLD, CAM_WORLD, settings, 4).ok).toBe(false);
    }
    expect(generateFacing(rectangle, CAM_WORLD, tilted, settings, 4).ok).toBe(false);
    expect(generateFacing(rectangle, CAM_WORLD, CAM_WORLD, settings, NaN).ok).toBe(false);
  });
});
