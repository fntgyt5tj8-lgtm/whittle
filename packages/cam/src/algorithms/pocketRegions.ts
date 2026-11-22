import { area, EndType, FillRule, inflatePaths, JoinType, pointInPolygon, PointInPolygonResult, union,
  type Path64 } from "clipper2-ts";
import type { CamResult } from "../model";
import { contourPoint, curveDistance, orderContour, type ContourCurve, type ContourPoint } from "./contour";

export const POCKET_INTEGER_SCALE = 100_000;
const SCALE = POCKET_INTEGER_SCALE;
const ARC_ERROR = 0.001;
const ROUND_ERROR = 0.0001;
const OFFSET_MARGIN = ARC_ERROR + ROUND_ERROR + 4 / SCALE;
export const POCKET_OFFSET_EDGE_LIMIT = "The pocket generates too many offset edges. Increase engagement or stepover, or use a larger cutter.";
export const POCKET_OFFSET_LEVEL_LIMIT = "The pocket needs too many offsets. Increase engagement or stepover, or use a larger cutter.";
const CONNECTION_TOLERANCE = 1e-5;
const MAX_OFFSET_LEVELS = 500;
const MAX_CUT_EDGES = 30_000;
const fail = (message: string): CamResult<never> => ({ ok: false, errors: [message] });

export function pocketBoundaries(input: readonly ContourCurve[]): CamResult<readonly (readonly ContourCurve[])[]> {
  if (!input.length || input.length > 500) return fail("Choose a pocket sketch with 1 to 500 edges.");
  const endpoints = input.map((curve) => [contourPoint(curve, 0), contourPoint(curve, 1)]);
  const remaining = new Set(input.keys());
  const loops: ContourCurve[][] = [];
  for (const first of remaining) {
    remaining.delete(first);
    const component = [first];
    for (const edge of component) {
      for (const candidate of remaining) {
        if (!endpoints[edge]!.some((a) => endpoints[candidate]!.some((b) =>
          Math.hypot(a[0] - b[0], a[1] - b[1]) <= CONNECTION_TOLERANCE))) continue;
        remaining.delete(candidate);
        component.push(candidate);
      }
    }
    const ordered = orderContour(component.map((index) => input[index]!));
    if (!ordered.ok) return ordered;
    if (!ordered.value.closed) return fail("Close each pocket boundary and island loop in the sketch.");
    loops.push(ordered.value.curves);
  }
  return { ok: true, value: loops };
}

function bounds(curve: ContourCurve) {
  return curve.kind === "arc"
    ? [curve.c[0] - curve.r, curve.c[1] - curve.r, curve.c[0] + curve.r, curve.c[1] + curve.r]
    : [Math.min(curve.a[0], curve.b[0]), Math.min(curve.a[1], curve.b[1]),
      Math.max(curve.a[0], curve.b[0]), Math.max(curve.a[1], curve.b[1])];
}

function nearBounds(a: number[], b: number[], distance: number) {
  return a[0]! <= b[2]! + distance && b[0]! <= a[2]! + distance
    && a[1]! <= b[3]! + distance && b[1]! <= a[3]! + distance;
}

/** Normalize nested loops by even-odd fill, then erode the complete region together. */
export function offsetPocket(
  loops: readonly (readonly ContourCurve[])[], radius: number, step: number, roundError = ROUND_ERROR, separateIslands = 0,
): CamResult<{ wall: ContourCurve[]; levels: ContourCurve[][][] }> {
  const source = loops.map((loop) => loop.map((curve) => ({ curve, box: bounds(curve) })));
  for (const [i, loop] of source.entries()) {
    if (source.slice(i + 1).some((other) => loop.some((a) => other.some((b) =>
      nearBounds(a.box, b.box, 2 * OFFSET_MARGIN) && curveDistance(a.curve, b.curve) <= 2 * OFFSET_MARGIN)))) {
      return fail("Pocket boundaries cross, touch, or are too close to resolve reliably.");
    }
  }
  const [ox, oy] = contourPoint(loops[0]![0]!, 0);
  const toInteger = ([x, y]: ContourPoint) => ({ x: Math.round((x - ox) * SCALE), y: Math.round((y - oy) * SCALE) });
  const fromInteger = ({ x, y }: Path64[number]): ContourPoint => [ox + x / SCALE, oy + y / SCALE];
  const polygons: Path64[] = [];
  let vertices = 0;
  for (const loop of loops) {
    const polygon: Path64 = [];
    for (const curve of loop) {
      const count = curve.kind === "line" ? 1 : Math.max(4, Math.ceil(Math.abs(curve.sweep)
        / (2 * Math.acos(Math.max(0, 1 - ARC_ERROR / curve.r)))));
      vertices += count;
      if (vertices > 12_000) return fail("Pocket boundaries require too many offset vertices.");
      for (let i = 0; i < count; i++) polygon.push(toInteger(contourPoint(curve, i / count)));
    }
    if (polygon.some(({ x, y }) => !Number.isSafeInteger(x) || !Number.isSafeInteger(y)
      || Math.abs(x) > 1e12 || Math.abs(y) > 1e12)
      || Math.abs(area(polygon)) <= 1) return fail("A pocket boundary has an unsupported size or negligible area.");
    polygons.push(polygon);
  }

  const contains = (polygon: Path64, other: Path64) =>
    pointInPolygon(other[0]!, polygon) === PointInPolygonResult.IsInside;
  const primary = polygons.slice(0, polygons.length - separateIslands);
  const islands = polygons.slice(primary.length);
  for (const island of islands) {
    if (primary.filter((polygon) => contains(polygon, island)).length % 2 === 0
      || polygons.some((polygon) => polygon !== island && contains(island, polygon))
      || islands.some((other) => other !== island && contains(other, island))) {
      return fail("Each separate island must lie entirely inside the pocket and outside other islands.");
    }
  }
  const region = union(polygons, FillRule.EvenOdd);
  if (region.length !== polygons.length) return fail("Pocket boundary topology could not be resolved at the offset tolerance.");
  const original = source.flat();
  const levels: ContourCurve[][][] = [];
  let edges = 0;
  for (let level = 0; level <= MAX_OFFSET_LEVELS; level++) {
    const distance = radius + ARC_ERROR + roundError + 4 / SCALE + level * step;
    const paths = inflatePaths(region, -distance * SCALE, JoinType.Round, EndType.Polygon, 2, roundError * SCALE);
    if (!paths.length) break;
    if (level === MAX_OFFSET_LEVELS) return fail(POCKET_OFFSET_LEVEL_LIMIT);
    const chains: ContourCurve[][] = [];
    for (const path of paths) {
      edges += path.length;
      if (edges > MAX_CUT_EDGES) return fail(POCKET_OFFSET_EDGE_LIMIT);
      const first = path[0]!;
      const inside = polygons.filter((polygon) => pointInPolygon(first, polygon) === PointInPolygonResult.IsInside);
      if (inside.length % 2 === 0) return fail("An offset leaves the pocket. Try a different cutter or stepover.");
      const points = path.map(fromInteger);
      const curves: ContourCurve[] = points.map((a, i) => ({ kind: "line", a, b: points[(i + 1) % points.length]! }));
      for (const curve of curves) {
        const box = bounds(curve);
        if (original.some((wall) => nearBounds(box, wall.box, radius) && curveDistance(curve, wall.curve) < radius - 1e-7)) {
          return fail("An offset would gouge a pocket boundary. Try a different cutter or stepover.");
        }
      }
      chains.push(curves);
    }
    levels.push(chains);
  }
  const wall = levels[0]?.[0];
  if (!wall) return fail("The cutter does not fit inside this pocket.");
  // Clear inner rings first and leave the cutter-radius perimeters for last.
  return { ok: true, value: { wall, levels: levels.reverse() } };
}
