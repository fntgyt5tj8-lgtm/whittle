import { describe, expect, it } from "vitest";
import { CAM_WORLD, exportAptCl, generateAdaptive, validateToolpath, type ContourCurve, type ContourPoint } from "../src";

const circle: ContourCurve = { kind: "arc", c: [2, 3], r: 5, start: 0, sweep: 2 * Math.PI };
const settings = { depth: "1.25", clearance: "2", stepdown: "0.5", stepover: "15" };
const generate = (stepover = settings.stepover, input: readonly ContourCurve[] = [circle], diameter = 2) =>
  generateAdaptive(input, CAM_WORLD, CAM_WORLD, { ...settings, stepover }, diameter);

describe("circular adaptive clearing", () => {
  it("varies ring spacing with the cleared disk and stops at the compensated wall", () => {
    const result = generate();
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const path = result.value;
    const rings = path.motions.filter((motion) => motion.kind === "arc" && motion.start[2] === -0.5);
    const radii = rings.filter((_, i) => i % 2 === 0).map((ring) => Math.hypot(ring.start[0] - 2, ring.start[1] - 3));
    const increments = radii.map((r, i) => r - (radii[i - 1] ?? 0));
    expect(increments[0]!).toBeLessThan(0.3);
    expect(increments[1]!).toBeGreaterThan(increments[0]!);
    expect(radii.at(-1)).toBeCloseTo(4);
    // Independent grid integration of the exposed unit cutter disk.
    const cap = Math.acos(0.7) - 0.7 * Math.sqrt(1 - 0.7 ** 2);
    for (const [i, r] of radii.entries()) {
      const cleared = 1 + (radii[i - 1] ?? 0);
      let exposed = 0;
      const step = 0.015;
      for (let x = -1 + step / 2; x < 1; x += step) {
        for (let y = -1 + step / 2; y < 1; y += step) {
          if (x * x + y * y < 1 && (x + r) ** 2 + y * y > cleared ** 2) exposed += step ** 2;
        }
      }
      expect(exposed).toBeLessThan(cap + 0.012);
    }
    expect(path.cuttingPasses.map((pass) => pass[0]![2])).toEqual([-0.5, -1, -1.25]);
    expect(path.pointAt(0)).toEqual([2, 3, 2]);
    expect(path.pointAt(1)[2]).toBe(2);
    expect(path.linkingMoves.filter(([a, b]) => a[0] !== b[0] || a[1] !== b[1])
      .every(([a, b]) => a[2] === 2 && b[2] === 2)).toBe(true);
    expect(validateToolpath({ tool: { kind: "flat-endmill", diameter: 2 }, feed: 100, plungeFeed: 25, motions: path.motions })).toEqual([]);
    const coarser = generate("35");
    expect(coarser.ok && coarser.value.motions.length < path.motions.length).toBe(true);
  });

  it("reports invalid geometry, engagement and cutter sizes", () => {
    expect(generate("0").ok).toBe(false);
    expect(generate("51").ok).toBe(false);
    expect(generate("15", [circle, circle]).ok).toBe(false);
    expect(generate("15", [{ kind: "line", a: [0, 0], b: [4, 0] }]).ok).toBe(false);
    expect(generate("15", [circle], 10).ok).toBe(false);
  });

  it("clears concave lobes with the same neutral links when the neck is too narrow", () => {
    const vertices: ContourPoint[] = [[0, 0], [5, 0], [5, 2], [8, 2], [8, 0], [13, 0],
      [13, 5], [8, 5], [8, 3], [5, 3], [5, 5], [0, 5]];
    const boundary: ContourCurve[] = vertices.map((a, i) => ({ kind: "line", a, b: vertices[(i + 1) % vertices.length]! }));
    const result = generate("30", boundary);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const path = result.value;
    expect(path.adaptiveTransitionCuts).toBe(2);
    expect([...new Set(path.cuttingPasses.map((pass) => pass[0]![2]))]).toEqual([-0.5, -1, -1.25]);
    for (const pass of path.cuttingPasses) {
      expect(pass.every(([x]) => x < 6) || pass.every(([x]) => x > 7)).toBe(true);
    }
    const lateral = path.motions.filter(({ start, end }) => (start[0] < 6 && end[0] > 7) || (start[0] > 7 && end[0] < 6));
    expect(lateral.length).toBeGreaterThan(0);
    expect(lateral.every((move) => move.kind === "line" && move.mode === "rapid" && move.start[2] === 2 && move.end[2] === 2)).toBe(true);
  });

  it("respects concave walls and an island in the same sketch", () => {
    const vertices: ContourPoint[] = [[0, 0], [16, 0], [16, 5], [10, 5], [10, 12], [0, 12]];
    const boundary: ContourCurve[] = vertices.map((a, i) => ({ kind: "line", a, b: vertices[(i + 1) % vertices.length]! }));
    const island: ContourCurve = { ...circle, c: [5, 6], r: 1.5 };
    const result = generate("30", [...boundary, island]);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const path = result.value;
    expect(path.programmedPaths).toHaveLength(2);
    for (const [x, y] of path.cuttingPasses.flat()) {
      expect(Math.hypot(x - 5, y - 6)).toBeGreaterThanOrEqual(2.5 - 1e-7);
      expect(x > 10 && y > 4 || y > 5 && x > 9).toBe(false);
    }
  });

  it("uses swept stock to skip some candidate offsets while preserving a circular island", () => {
    const outer = { ...circle, r: 8 };
    const island = { ...circle, r: 2, sweep: -2 * Math.PI };
    const result = generate("15", [island, outer]);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const path = result.value;
    expect(path.programmedPaths).toHaveLength(2);
    expect(path.adaptiveTransitionCuts).toBe(1);
    const nominalLevels = Math.floor((outer.r - island.r - 2) / 2 / (0.3 / 5)) + 1;
    const depthCuts = path.cuttingPasses.filter((pass) => pass[0]![2] === -0.5);
    expect(depthCuts.length).toBeLessThan(2 * nominalLevels);
    expect(depthCuts.length).toBeGreaterThan(2);
    for (const [x, y] of depthCuts.flat()) {
      expect(Math.hypot(x - 2, y - 3)).toBeGreaterThanOrEqual(3 - 1e-7);
      expect(Math.hypot(x - 2, y - 3)).toBeLessThanOrEqual(7 + 1e-7);
    }
    expect(validateToolpath({ tool: { kind: "flat-endmill", diameter: 2 }, feed: 100, plungeFeed: 25, motions: path.motions })).toEqual([]);
  });


  it("emits descending neutral arcs at each stepdown and interpolates ramp playback", () => {
    const result = generateAdaptive([circle], CAM_WORLD, CAM_WORLD, {
      ...settings, entry: "helix", helixDiameter: "1", rampAngle: "5",
    }, 2);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const path = result.value;
    expect(path.entryPaths.map((trace) => [trace[0]![2], trace.at(-1)![2]])).toEqual([
      [0, -0.5], [-0.5, -1], [-1, -1.25],
    ]);
    const arcs = path.motions.filter((move) => move.kind === "arc" && move.helical);
    expect(arcs.length).toBeGreaterThan(6);
    for (const { start, end } of arcs) {
      const angle = Math.atan2(start[2] - end[2], Math.PI * 0.5) * 180 / Math.PI;
      expect(angle).toBeGreaterThan(0);
      expect(angle).toBeLessThanOrEqual(5 + 1e-10);
    }
    const first = arcs[0]!;
    const halfArcLength = Math.hypot(Math.PI * 0.5, first.start[2] - first.end[2]);
    const [x, y, z] = path.pointAt((2 + halfArcLength / 2) / path.length);
    expect(x).toBeCloseTo(2);
    expect(y).toBeCloseTo(3.5);
    expect(z).toBeCloseTo((first.start[2] + first.end[2]) / 2);
    const toolpath = { tool: { kind: "flat-endmill" as const, diameter: 2 }, feed: 100, plungeFeed: 25, motions: path.motions };
    expect(validateToolpath(toolpath)).toEqual([]);
    expect(exportAptCl(toolpath)).toMatchObject({ ok: false, errors: [expect.stringContaining("helical")] });
  });

  it("fits the entire helix and cutter within an annular pocket", () => {
    const outer = { ...circle, r: 8 };
    const island = { ...circle, r: 2 };
    const result = generateAdaptive([island, outer], CAM_WORLD, CAM_WORLD, {
      ...settings, depth: "0.5", stepover: "30", entry: "helix", helixDiameter: "1", rampAngle: "8",
    }, 2);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const path = result.value;
    expect(path.entryPaths.length).toBe(path.cuttingPasses.length);
    for (const [x, y] of path.entryPaths.flat()) {
      expect(Math.hypot(x - 2, y - 3)).toBeGreaterThanOrEqual(3 - 1e-7);
      expect(Math.hypot(x - 2, y - 3)).toBeLessThanOrEqual(7 + 1e-7);
    }
    const unavailable = generateAdaptive([island, outer], CAM_WORLD, CAM_WORLD, {
      ...settings, stepover: "30", entry: "helix", helixDiameter: "5",
    }, 2);
    expect(unavailable).toMatchObject({ ok: false, errors: [expect.stringContaining("helix does not fit")] });
  });

  it("rejects invalid ramp settings and keeps legacy plunge when entry is omitted", () => {
    expect(generateAdaptive([circle], CAM_WORLD, CAM_WORLD, { ...settings, entry: "helix", rampAngle: "0" }, 2).ok).toBe(false);
    expect(generateAdaptive([circle], CAM_WORLD, CAM_WORLD, { ...settings, entry: "helix", helixDiameter: "-1" }, 2).ok).toBe(false);
    const legacy = generate();
    expect(legacy.ok && legacy.value.entryPaths).toEqual([]);
  });

  it("plans a large curved pocket at default engagement without exhausting the offset-edge budget", () => {
    const result = generateAdaptive([{ ...circle, r: 14 }, { ...circle, r: 2 }], CAM_WORLD, CAM_WORLD, {
      ...settings, depth: "2", stepdown: "", entry: "helix", helixDiameter: "2", stayDown: true,
    }, 1);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.value.cuttingPasses.length).toBeGreaterThan(10);
    expect(result.value.entryPaths.length).toBeGreaterThan(0);
    expect(result.value.programmedPaths).toHaveLength(2);
  });
});
