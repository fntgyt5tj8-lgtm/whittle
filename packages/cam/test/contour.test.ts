import { describe, expect, it } from "vitest";
import { CAM_WORLD, contourTravel, exportAptCl, generateContour, type CamFrame, type ContourCurve, type ContourMillingSettings } from "../src";

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

  it.each([
    ["cw", "climb", "left"], ["cw", "conventional", "right"],
    ["ccw", "climb", "right"], ["ccw", "conventional", "left"],
  ] as const)("uses %s spindle rotation and %s travel with the tool on the %s", (spindleDirection, millingDirection, travelSide) => {
    for (const side of ["left", "right"] as const) {
      const options = { ...settings, side, spindleDirection, millingDirection };
      const open = [line([0, 0], [4, 0])];
      const baseline = path(open, { side }).centerline;
      const travel = contourTravel(options);
      expect(travel.side).toBe(travelSide);
      expect(path(open, options).centerline).toEqual(travelSide === side ? baseline : [...baseline].reverse());
    }
  });

  it("keeps the compensated closed seam when changing milling direction", () => {
    const options = { side: "right", seam: "0.175" } as const;
    const manual = path(square, options);
    const climb = path(square, { ...options, millingDirection: "climb" });
    const reversed = [...manual.centerline].reverse();
    expect(climb.centerline).toHaveLength(reversed.length);
    climb.centerline.forEach((point, index) => {
      point.forEach((value, axis) => expect(value).toBeCloseTo(reversed[index]![axis]!, 10));
    });
    expect(climb.contourHandles![0]!.position).toEqual(manual.contourHandles![0]!.position);
    expect(climb.pointAt(0)).toEqual(manual.pointAt(0));
  });

  it("cuts radial passes at each depth with an exact finish allowance and clearance links", () => {
    const open = [line([0, 0], [4, 0])];
    const cut = path(open, {
      stockAllowance: "2", radialIncrement: "0.7", finishAllowance: "0.3",
      depth: "1.5", stepdown: "1", leadIn: "1", leadOut: "1",
    });
    expect(cut.cuttingPasses).toHaveLength(8);
    for (const [i, points] of cut.cuttingPasses.entries()) {
      const y = [2.5, 1.8, 1.1, 0.8][i % 4]!;
      const z = i < 4 ? -1 : -1.5;
      expect(points[0]).toEqual([-1, expect.closeTo(y), z]);
      expect(points.at(-1)).toEqual([5, expect.closeTo(y), z]);
    }
    expect(cut.centerline).toEqual([[0, 0.8, -1.5], [4, 0.8, -1.5]]);
    for (const motion of cut.motions) {
      if (motion.kind === "line" && motion.mode === "rapid" && motion.start[0] !== motion.end[0]) {
        expect([motion.start[2], motion.end[2]]).toEqual([2, 2]);
      }
    }
    expect(cut.motions.filter((motion) => motion.kind === "line" && motion.mode === "plunge")).toHaveLength(8);
    expect(path(open, { stockAllowance: "1.5" }).centerline).toEqual([[0, 2, -1], [4, 2, -1]]);
  });

  it("replaces checked radial retracts with same-depth feed links and keeps depth changes at clearance", () => {
    const circle: ContourCurve = { kind: "arc", c: [0, 0], r: 4, start: 0, sweep: 2 * Math.PI };
    const options = {
      side: "right", optimiseRetracts: true, stockAllowance: "1", radialIncrement: "0.5",
      depth: "2", stepdown: "1", arcLeadIn: "90", arcLeadOut: "90", arcLeadInRadius: "0.5", arcLeadOutRadius: "0.5",
    } as const;
    const cut = path([circle], options, 2);
    const baseline = path([circle], { ...options, optimiseRetracts: false }, 2);
    expect(cut.cuttingPasses).toEqual(baseline.cuttingPasses);
    expect(cut.stayDownLinkCount).toBe(4);
    expect(cut.motions.filter((motion) => motion.kind === "line" && motion.mode === "link")
      .map(({ start, end }) => [start[2], end[2]])).toEqual([[-1, -1], [-1, -1], [-2, -2], [-2, -2]]);
    expect(cut.motions.filter((motion) => motion.kind === "line" && motion.mode === "plunge")).toHaveLength(2);
    expect(baseline.motions.filter((motion) => motion.kind === "line" && motion.mode === "plunge")).toHaveLength(6);
    expect(cut.motions.at(-1)).toMatchObject({ kind: "line", mode: "rapid", end: [expect.any(Number), expect.any(Number), 2] });
  });

  it("uses clearance when the direct link would cross the protected finish allowance", () => {
    // The inward chord is short enough, but crosses the programmed circle.
    const arc: ContourCurve = { kind: "arc", c: [0, 0], r: 4, start: 0, sweep: 2 * Math.PI - 0.55 };
    const options = { side: "right", optimiseRetracts: true, stockAllowance: "0.05", radialIncrement: "0.05" } as const;
    const cut = path([arc], options, 4);
    expect(cut.stayDownLinkCount).toBe(0);
    expect(cut.motions).toEqual(path([arc], { ...options, optimiseRetracts: false }, 4).motions);
  });

  it("preserves circular moves and the final seam at each radial allowance", () => {
    const circle: ContourCurve = { kind: "arc", c: [0, 0], r: 4, start: 0, sweep: 2 * Math.PI };
    const cut = path([circle], {
      side: "right", millingDirection: "climb", seam: "0.25",
      stockAllowance: "1.25", radialIncrement: "0.5", finishAllowance: "0.25",
    }, 2);
    const expected = [6.25, 5.75, 5.25];
    expect(cut.cuttingPasses.map((points) => points[0]![1])).toEqual(expected);
    expect(cut.contourHandles![0]!.position[1]).toBe(5.25);
    expect(cut.motions.filter((motion) => motion.kind === "arc").map(({ start }) => Math.hypot(start[0], start[1])))
      .toEqual(expected.flatMap((r) => [r, r]));
    const apt = exportAptCl({ tool: { kind: "flat-endmill", diameter: 2 }, feed: 100, plungeFeed: 25, motions: cut.motions });
    if (!apt.ok) throw new Error(apt.errors.join("\n"));
    expect(apt.value.match(/CIRCLE\//g)).toHaveLength(9);
  });

  it("validates radial pass settings and rejects a collapsed roughing offset", () => {
    const open = [line([0, 0], [4, 0])];
    expect(generate(open, { side: "center", stockAllowance: "1" }).ok).toBe(false);
    expect(generate(open, { stockAllowance: "-1" }).ok).toBe(false);
    expect(generate(open, { radialIncrement: "-1" }).ok).toBe(false);
    expect(generate(open, { stockAllowance: "1", radialIncrement: "0.5", finishAllowance: "2" }).ok).toBe(false);
    expect(generate(open, { stockAllowance: "1", radialIncrement: "0.001" }).ok).toBe(false);
    const circle: ContourCurve = { kind: "arc", c: [0, 0], r: 2, start: 0, sweep: 2 * Math.PI };
    expect(generate([circle], { stockAllowance: "2", radialIncrement: "1" }))
      .toMatchObject({ ok: false, errors: [expect.stringContaining("Radial pass")] });
  });

  it("projects the open handles independently onto the compensated endpoint tangent rays", () => {
    const open = [line([0, 0], [4, 0]), quarterArc];
    const [entry, exit] = path(open).contourHandles!;
    expect(entry!.key).toBe("leadIn");
    expect(entry!.project([-2, 9, -1])).toMatchObject({ value: 2, position: [-2, 0.5, -1] });
    expect(entry!.project([1, 0.5, -1]).value).toBe(0);
    const proposed = exit!.project([7, 5, -1]);
    expect(exit!.key).toBe("leadOut");
    expect(proposed.value).toBeCloseTo(3);
    const updated = path(open, { leadOut: String(proposed.value) });
    expect(updated.programmed).toEqual(path(open).programmed);
    expect(updated.cuttingPasses[0]!.at(-1)).toEqual(proposed.position);
    expect(updated.motions.at(-1)).toMatchObject({ kind: "line", mode: "rapid", start: proposed.position });
    const [reverseEntry] = path(open, { direction: "reverse", side: "right" }).contourHandles!;
    expect(reverseEntry!.project([7, 5, -1]).value).toBeCloseTo(3);
  });

  it("combines tangent, tangent arc, and normal leads independently at both ends", () => {
    const open = [line([0, 0], [10, 0])];
    const options = { leadIn: "1", arcLeadIn: "90", arcLeadInRadius: "2", normalLeadIn: "1",
      leadOut: "1", arcLeadOut: "90", arcLeadOutRadius: "3", normalLeadOut: "1" };
    const cut = path(open, options, 2);
    expect(cut.centerline).toEqual([[0, 1, -1], [10, 1, -1]]);
    expect(cut.pointAt(0)).toEqual([-3, expect.closeTo(4), 2]);
    const arcs = cut.motions.filter((motion) => motion.kind === "arc");
    expect(arcs).toHaveLength(2);
    expect(arcs[0]).toMatchObject({ center: [-1, 3, -1], start: [-3, expect.closeTo(3), -1], direction: "ccw" });
    expect(arcs[1]).toMatchObject({ center: [11, 4, -1], start: [11, 1, -1], direction: "ccw" });
    expect(cut.motions.at(-1)).toMatchObject({ kind: "line", mode: "rapid", start: [14, 5, -1], end: [14, 5, 2] });
    const apt = exportAptCl({ tool: { kind: "flat-endmill", diameter: 2 }, feed: 100, plungeFeed: 25, motions: cut.motions });
    if (!apt.ok) throw new Error(apt.errors.join("\n"));
    expect(apt.value.match(/CIRCLE\//g)).toHaveLength(2);
    const reversed = path(open, { ...options, side: "right", direction: "reverse" }, 2);
    expect(reversed.centerline).toEqual([[10, 1, -1], [0, 1, -1]]);
    expect(reversed.pointAt(0)).toEqual([13, expect.closeTo(4), 2]);
    expect(reversed.motions.filter((motion) => motion.kind === "arc").every((arc) => arc.direction === "cw")).toBe(true);
  });

  it("activates individual lead values and checks each segment against the contour", () => {
    const open = [line([0, 0], [10, 0])];
    expect(path(open, { normalLeadIn: "1" }, 2).pointAt(0)).toEqual([0, 2, 2]);
    const arc = path(open, { arcLeadOut: "90" }, 2).motions.find((motion) => motion.kind === "arc");
    expect(arc).toMatchObject({ center: [10, 2, -1], end: [11, 2, -1] });
    expect(generate(open, { arcLeadIn: "90", arcLeadInRadius: "0" }).ok).toBe(false);
    expect(generate(open, { arcLeadIn: "181" }).ok).toBe(false);
    expect(generate(open, { normalLeadOut: "-1" }).ok).toBe(false);
    // A normal move from the inside of the loop crosses the far side.
    expect(generate(square, { seam: "0.125", normalLeadOut: "4" }))
      .toMatchObject({ ok: false, errors: [expect.stringContaining("Lead-out crosses")] });
    const outside = path(square, { side: "right", seam: "0.1", arcLeadIn: "90", normalLeadIn: "1" });
    expect(outside.motions.some((motion) => motion.kind === "arc")).toBe(true);
  });

  it("splits a compensated line at the closed seam and preserves the full cutting loop", () => {
    const initial = path(square);
    const handle = initial.contourHandles![0]!;
    expect(handle.key).toBe("seam");
    const edit = handle.project([2, 0, -1]);
    expect(edit).toEqual({ value: 0.125, position: [2, 0.5, -1], traceFrom: [2, 0.5, 2] });
    const cut = path(square, { seam: String(edit.value) });
    expect(cut.programmed).toEqual(initial.programmed);
    expect(cut.cuttingPasses[0]).toEqual([
      [2, 0.5, -1], [3.5, 0.5, -1], [3.5, 3.5, -1], [0.5, 3.5, -1], [0.5, 0.5, -1], [2, 0.5, -1],
    ]);
    expect(cut.length).toBeCloseTo(initial.length);
    expect(path(square, { seam: "1" }).motions).toEqual(initial.motions);
    expect(generate(square, { seam: "1.1" }).ok).toBe(false);
  });

  it("keeps analytic seam arcs, travel direction and clearance in an indexed tool frame", () => {
    const circle: ContourCurve = { kind: "arc", c: [0, 0], r: 4, start: 0, sweep: 2 * Math.PI };
    const frame: CamFrame = { origin: [10, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] };
    for (const direction of ["forward", "reverse"] as const) {
      const cut = path([circle], { seam: "0.25", direction, side: direction === "forward" ? "right" : "left",
        depth: "2", stepdown: "1" }, 2, frame, frame);
      const sign = direction === "forward" ? 1 : -1;
      const handle = cut.contourHandles![0]!;
      expect(handle.normal).toEqual([1, 0, 0]);
      expect(handle.position[0]).toBe(8);
      expect(handle.position[2]).toBeCloseTo(5 * sign);
      expect(handle.project([8, 0, 7 * sign]).value).toBeCloseTo(0.25);
      expect(cut.pointAt(0)[0]).toBe(12);
      const arcs = cut.motions.filter((motion) => motion.kind === "arc");
      expect(arcs).toHaveLength(4);
      expect(arcs.every((arc) => arc.direction === (direction === "forward" ? "ccw" : "cw"))).toBe(true);
      const apt = exportAptCl({
        tool: { kind: "flat-endmill", diameter: 2 }, feed: 100, plungeFeed: 25, motions: cut.motions,
      });
      if (!apt.ok) throw new Error(apt.errors.join("\n"));
      expect(apt.value.match(/CIRCLE\//g)).toHaveLength(6);
    }
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

  it("offsets an open U inward in the YZ plane with a +X tool axis", () => {
    const yz: CamFrame = { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] };
    const cy = 0.854340269633684, cz = 12.5;
    // The APT profile has a small angular mismatch at each nominal tangent join.
    for (const tilt of [0, Math.atan2(0.0000380307111, 8)]) {
      const radius = 8;
      const y = radius * Math.cos(tilt), z = cz + radius * Math.sin(tilt);
      const u: ContourCurve[] = [
        line([cy + y, 30], [cy + y, z]),
        { kind: "arc", c: [cy, cz], r: radius, start: tilt, sweep: -Math.PI - 2 * tilt },
        line([cy - y, z], [cy - y, 30]),
      ];
      for (const direction of ["forward", "reverse"] as const) {
        const forward = direction === "forward";
        const side = forward ? "right" : "left";
        const cut = generateContour(u, yz, yz, { ...settings, side, direction }, 6, CAM_WORLD);
        if (!cut.ok) throw new Error(cut.errors.join("\n"));
        const moves = cut.value.motions.filter((move) => move.kind === "arc" || move.mode === "feed");
        expect(moves.map((move) => move.kind)).toEqual(tilt
          ? ["line", "arc", "arc", "arc", "line"] : ["line", "arc", "line"]);
        const arc = moves[Math.floor(moves.length / 2)]!;
        expect(arc).toMatchObject({ kind: "arc", center: [-1, cy, cz], normal: [1, 0, 0],
          direction: forward ? "cw" : "ccw" });
        expect(Math.hypot(arc.start[1] - cy, arc.start[2] - cz)).toBeCloseTo(5, 10);
        const start = moves[0]!.start, end = moves.at(-1)!.end;
        expect(start).toEqual([-1, cy + (forward ? y : -y) + (forward ? -3 : 3), 30]);
        expect(end).toEqual([-1, cy + (forward ? -y : y) + (forward ? 3 : -3), 30]);
        for (const [i, move] of moves.slice(1).entries()) {
          expect(Math.hypot(...move.start.map((v, j) => v - moves[i]!.end[j]!))).toBeLessThan(1e-10);
        }
      }
    }
  });

  it("exports an offset with nearly tangent joins at multiple depths", () => {
    const tilt = 2e-6;
    const y = 8 * Math.cos(tilt), z = 8 * Math.sin(tilt);
    const u: ContourCurve[] = [
      line([y, 20], [y, z]),
      { kind: "arc", c: [0, 0], r: 8, start: tilt, sweep: -Math.PI - 2 * tilt },
      line([-y, z], [-y, 20]),
    ];
    const cut = path(u, { side: "right", depth: "2", stepdown: "1" }, 6);
    const result = exportAptCl({
      tool: { kind: "flat-endmill", diameter: 6 }, feed: 100, plungeFeed: 25, motions: cut.motions,
    });
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.value.match(/CIRCLE\//g)).toHaveLength(4);
    for (const [i, motion] of cut.motions.slice(1).entries()) {
      expect(motion.start).toEqual(cut.motions[i]!.end);
    }
  });

  it("rejects an offset that gouges a nonadjacent segment of an open contour", () => {
    const folded = [line([0, 0], [10, 0]), line([10, 0], [10, 12]), line([10, 12], [-5, 12]),
      line([-5, 12], [-5, 4]), line([-5, 4], [8, 4])];
    expect(generate(folded, {}, 6)).toMatchObject({
      ok: false, errors: [expect.stringContaining("cuts into another part of the contour")],
    });
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
