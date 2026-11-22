import { describe, expect, it } from "vitest";
import { CAM_WORLD, generateAdaptive, validateToolpath, type ContourCurve, type ContourPoint } from "../src";
import { buildPlanarPreview } from "../src/algorithms/contour";
import { createAdaptiveLinkPlanner } from "../src/algorithms/adaptiveLinks";

const line = (a: ContourPoint, b: ContourPoint): ContourCurve => ({ kind: "line", a, b });
const chain = (points: ContourPoint[]) => points.slice(1).map((b, i) => line(points[i]!, b));
const circle = (r: number): ContourCurve => ({ kind: "arc", c: [2, 3], r, start: 0, sweep: 2 * Math.PI });

describe("stock-aware adaptive links", () => {
  it("certifies a direct swept path in cleared stock and refuses a gap between cleared endpoints", () => {
    const planner = createAdaptiveLinkPlanner([0, 0], 1, [], 0);
    const left = chain([[0, 0], [4, 0], [4, 0.5], [0, 0.5], [0, 1], [4, 1], [4, 0.5], [3, 0.5]]);
    const next = [line([1, 0.5], [2, 0.5])];
    expect(planner.choose(next)).toBeUndefined();
    planner.record(left);
    expect(planner.choose(next)).toEqual({ cut: next, kind: "clear" });
    const diagonal = [line([1, 0.42], [2, 0.42])];
    expect(planner.choose(diagonal)?.kind).toBe("clear");
    planner.record(chain([[8, 0], [12, 0], [12, 0.5], [8, 0.5], [8, 1], [12, 1], [12, 0.5], [11, 0.5]]));
    expect(planner.choose(next)).toBeUndefined();
  });

  it("routes around an island through completed sweeps and emits same-depth feed segments", () => {
    const ring = (r: number): ContourCurve => ({ kind: "arc", c: [0, 0], r, start: 0, sweep: 2 * Math.PI });
    const cut = [line([4, 0], [5, 0]), ring(5), line([5, 0], [4, 0]), ring(4), line([4, 0], [4.5, 0])];
    const next = [line([-4.5, 0], [-4.6, 0])];
    const planner = createAdaptiveLinkPlanner([0, 0], 1, [ring(3), ring(6)], 0);
    expect(planner.choose(next)).toBeUndefined();
    planner.record(cut);
    const linked = planner.choose(next);
    expect(linked?.kind).toBe("clear");
    expect(linked?.waypoints?.length).toBeGreaterThan(0);
    const route = linked!.waypoints!;
    const points: readonly ContourPoint[] = [[4.5, 0], ...route, [-4.5, 0]];
    for (const [i, a] of points.slice(0, -1).entries()) {
      const b = points[i + 1]!;
      for (let sample = 0; sample <= 20; sample++) {
        const t = sample / 20;
        const r = Math.hypot(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
        expect(r).toBeGreaterThanOrEqual(4 - 1e-8);
        expect(r).toBeLessThanOrEqual(5 + 1e-8);
      }
    }
    const preview = buildPlanarPreview([[ring(6)], [ring(3)]], cut, [cut, next],
      CAM_WORLD, CAM_WORLD, [-0.5, -1], 2, undefined, [undefined, route]);
    if (!preview.ok) throw new Error(preview.errors.join("\n"));
    expect(preview.value.linkingMoves.filter(([a, b]) => a[2] === b[2] && a[2] < 0)).toHaveLength(2 * (route.length + 1));
    expect(validateToolpath({ tool: { kind: "flat-endmill", diameter: 2 }, feed: 100, plungeFeed: 25,
      motions: preview.value.motions })).toEqual([]);
  });

  it("takes checked short feed links, keeps full retracts across uncleared space, and resets at each depth", () => {
    const boundaries = [circle(8), circle(2)];
    const settings = { depth: "1", stepdown: "0.5", clearance: "2", stepover: "30", entry: "helix" as const, rampAngle: "5" };
    const legacy = generateAdaptive(boundaries, CAM_WORLD, CAM_WORLD, settings, 1);
    const linked = generateAdaptive(boundaries, CAM_WORLD, CAM_WORLD, { ...settings, stayDown: true }, 1);
    if (!legacy.ok || !linked.ok) throw new Error("The annular pocket needs to generate in both modes.");
    const path = linked.value;
    expect(path.stayDownLinkCount).toBeGreaterThan(0);
    expect(path.stayDownCutLinkCount).toBeGreaterThan(0);
    expect(path.entryPaths.length + path.stayDownLinkCount!).toBe(legacy.value.entryPaths.length);
    expect(path.entryPaths.length).toBeGreaterThan(2);
    expect(path.entryPaths.filter((ramp) => ramp.at(-1)![2] === -0.5)).toHaveLength(path.entryPaths.length / 2);
    const lateral = path.motions.filter((move) => move.kind === "line" && move.mode === "rapid"
      && (move.start[0] !== move.end[0] || move.start[1] !== move.end[1]));
    expect(lateral.length).toBeGreaterThan(0);
    expect(lateral.every((move) => move.start[2] === 2 && move.end[2] === 2)).toBe(true);
    expect(validateToolpath({ tool: { kind: "flat-endmill", diameter: 1 }, feed: 100, plungeFeed: 25, motions: path.motions })).toEqual([]);
  });
});
