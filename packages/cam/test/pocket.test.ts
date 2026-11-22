import { describe, expect, it } from "vitest";
import { CAM_WORLD, generatePocket, validateToolpath, type ContourCurve, type ContourPoint } from "../src";

const settings = { depth: "2.25", stepdown: "1", clearance: "3", stepover: "50" };
const polygon = (points: ContourPoint[]): ContourCurve[] => points.map((a, i) =>
  ({ kind: "line", a, b: points[(i + 1) % points.length]! }));
const rectangle = polygon([[0, 0], [8, 0], [8, 4], [0, 4]]);
const circle: ContourCurve = { kind: "arc", c: [1, 2], r: 3, start: 0, sweep: 2 * Math.PI };

function pocket(curves: ContourCurve[], changes: Partial<typeof settings> = {}, diameter = 2) {
  return generatePocket(curves, CAM_WORLD, CAM_WORLD, { ...settings, ...changes }, diameter);
}
function preview(curves: ContourCurve[], changes: Partial<typeof settings> = {}, diameter = 2) {
  const result = pocket(curves, changes, diameter);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.value;
}

describe("2.5D pocket milling", () => {
  it("clears a rectangular pocket in raster rows, finishes the wall and links at clearance", () => {
    const cut = preview(rectangle);
    expect(cut.cuttingPasses.map((pass) => pass[0]![2])).toEqual([-1, -2, -2.25]);
    expect(cut.cuttingPasses[0]!.slice(0, 4)).toEqual([[1, 1.5, -1], [7, 1.5, -1], [7, 2.5, -1], [1, 2.5, -1]]);
    expect(cut.centerline).toHaveLength(5);
    for (const pass of cut.cuttingPasses) {
      expect(pass.every(([x, y]) => x >= 1 - 1e-8 && x <= 7 + 1e-8 && y >= 1 - 1e-8 && y <= 3 + 1e-8)).toBe(true);
    }
    expect(cut.pointAt(0)).toEqual([1, 1.5, 3]);
    expect(cut.pointAt(1)[2]).toBe(3);
    expect(cut.motions.filter((move) => move.kind === "line" && move.mode === "plunge")).toHaveLength(3);
    const lateralRapids = cut.motions.filter((move) => move.kind === "line" && move.mode === "rapid"
      && (move.start[0] !== move.end[0] || move.start[1] !== move.end[1]));
    expect(lateralRapids).toHaveLength(2);
    expect(lateralRapids.every(({ start, end }) => start[2] === 3 && end[2] === 3)).toBe(true);
    expect(validateToolpath({ tool: { kind: "flat-endmill", diameter: 2 }, feed: 100, plungeFeed: 25, motions: cut.motions })).toEqual([]);
  });

  it("starts circular clearing at the center and preserves concentric analytic arcs", () => {
    const cut = preview([circle], { stepdown: "", stepover: "25" });
    expect(cut.pointAt(0)).toEqual([1, 2, 3]);
    const arcs = cut.motions.filter((move) => move.kind === "arc");
    expect(arcs).toHaveLength(8);
    expect(arcs.map(({ start, center }) => Math.hypot(start[0] - center[0], start[1] - center[1])))
      .toEqual([0.5, 0.5, 1, 1, 1.5, 1.5, 2, 2]);
    expect(validateToolpath({ tool: { kind: "flat-endmill", diameter: 2 }, feed: 100, plungeFeed: 25, motions: cut.motions })).toEqual([]);
    expect(preview([circle], {}, 1).centerline[0]![0]).toBe(3.5);
  });

  it("keeps the tool envelope within sloped convex walls for either winding", () => {
    const vertices: ContourPoint[] = [[0, 0], [6, 1], [1, 7]];
    for (const boundary of [vertices, [...vertices].reverse()]) {
      const cut = preview(polygon(boundary), {});
      for (const [x, y] of cut.cuttingPasses[0]!) {
        for (const [i, a] of vertices.entries()) {
          const b = vertices[(i + 1) % vertices.length]!;
          const dx = b[0] - a[0], dy = b[1] - a[1];
          expect((dx * (y - a[1]) - dy * (x - a[0])) / Math.hypot(dx, dy)).toBeGreaterThanOrEqual(1 - 1e-8);
        }
      }
    }
  });

  it("rejects open, intersecting and undersized pockets and invalid stepover", () => {
    expect(pocket(rectangle.slice(0, -1)).ok).toBe(false);
    expect(pocket([...rectangle, circle]).ok).toBe(false);
    expect(pocket(rectangle, {}, 4).ok).toBe(false);
    expect(pocket([circle], {}, 6).ok).toBe(false);
    expect(pocket([circle], { stepover: "51" }).ok).toBe(false);
    expect(pocket([circle], { stepover: "0.0001" }).ok).toBe(false);
  });

  it("offsets a concave pocket whose narrow neck splits the cutter-center region", () => {
    const dumbbell = polygon([[0, 0], [5, 0], [5, 2], [8, 2], [8, 0], [13, 0], [13, 5],
      [8, 5], [8, 3], [5, 3], [5, 5], [0, 5]]);
    const cut = preview(dumbbell, { depth: "1", stepdown: "" });
    expect(cut.cuttingPasses.some((chain) => chain.every(([x]) => x < 6))).toBe(true);
    expect(cut.cuttingPasses.some((chain) => chain.every(([x]) => x > 7))).toBe(true);
    expect(cut.cuttingPasses.every((chain) => chain.every(([x]) => x < 6) || chain.every(([x]) => x > 7))).toBe(true);
    const across = cut.motions.filter(({ start, end }) => (start[0] < 6 && end[0] > 7) || (end[0] < 6 && start[0] > 7));
    expect(across.length).toBeGreaterThan(0);
    expect(across.every((move) => move.kind === "line" && move.mode === "rapid"
      && move.start[2] === 3 && move.end[2] === 3)).toBe(true);
  });

  it("preserves polygon and circular islands independent of sketch winding and order", () => {
    const outer = polygon([[0, 0], [18, 0], [18, 12], [0, 12]]);
    const square = polygon([[10, 4], [14, 4], [14, 8], [10, 8]]);
    const island = { ...circle, c: [5, 6] as const, r: 1.5 };
    const reversed = [...square, ...outer].map((curve) => curve.kind === "line" ? { ...curve, a: curve.b, b: curve.a } : curve);
    for (const input of [[...outer, ...square, island], [{ ...island, sweep: -island.sweep }, ...reversed]]) {
      const cut = preview(input);
      expect(cut.programmedPaths).toHaveLength(3);
      expect([...new Set(cut.cuttingPasses.map((pass) => pass[0]![2]))]).toEqual([-1, -2, -2.25]);
      for (const [x, y] of cut.cuttingPasses.flat()) {
        expect(Math.min(x, y, 18 - x, 12 - y)).toBeGreaterThanOrEqual(1 - 1e-7);
        expect(Math.hypot(x - 5, y - 6)).toBeGreaterThanOrEqual(2.5 - 1e-7);
        expect(Math.hypot(Math.max(10 - x, x - 14, 0), Math.max(4 - y, y - 8, 0))).toBeGreaterThanOrEqual(1 - 1e-7);
      }
      expect(validateToolpath({ tool: { kind: "flat-endmill", diameter: 2 }, feed: 100, plungeFeed: 25, motions: cut.motions })).toEqual([]);
    }
  });

  it("keeps a pocket inside an island and supports a disjoint outer loop", () => {
    const box = (x: number, y: number, size: number) =>
      polygon([[x, y], [x + size, y], [x + size, y + size], [x, y + size]]);
    const cut = preview([...box(0, 0, 20), ...box(5, 5, 10), ...box(8, 8, 4), ...box(25, 0, 4)],
      { depth: "1", stepdown: "" });
    expect(cut.programmedPaths).toHaveLength(4);
    expect(cut.cuttingPasses.some((chain) => chain.every(([x, y]) => x >= 9 && x <= 11 && y >= 9 && y <= 11))).toBe(true);
    expect(cut.cuttingPasses.some((chain) => chain.every(([x]) => x >= 26))).toBe(true);
    expect(cut.cuttingPasses.flat().filter(([x, y]) => x > 5 && x < 15 && y > 5 && y < 15)
      .every(([x, y]) => x >= 9 && x <= 11 && y >= 9 && y <= 11)).toBe(true);
  });

  it("rejects touching islands and a region entirely consumed by the cutter offset", () => {
    const touching = { ...circle, c: [4, 2] as const, r: 2 };
    const nearlySolid = { ...circle, c: [4, 2] as const, r: 1.9 };
    expect(pocket([...rectangle, touching]).ok).toBe(false);
    expect(pocket([...rectangle, nearlySolid], {}, 3).ok).toBe(false);
  });

  it("excludes explicitly supplied islands and refuses an island outside the primary boundary", () => {
    const outer: ContourCurve = { kind: "arc", c: [0, 0], r: 8, start: 0, sweep: 2 * Math.PI };
    const island: ContourCurve = { ...outer, r: 2 };
    const result = generatePocket([outer], CAM_WORLD, CAM_WORLD, settings, 2, [island]);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.value.programmedPaths).toHaveLength(2);
    expect(result.value.cuttingPasses.flat().every(([x, y]) => Math.hypot(x, y) >= 3 - 1e-7)).toBe(true);
    expect(generatePocket([outer], CAM_WORLD, CAM_WORLD, settings, 2, [{ ...island, c: [12, 0] }]).ok).toBe(false);
    expect(generatePocket([outer, island], CAM_WORLD, CAM_WORLD, settings, 2, [{ ...island, r: 1 }]).ok).toBe(false);
  });
});
