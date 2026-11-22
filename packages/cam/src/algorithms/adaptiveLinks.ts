import { areaPaths, difference, EndType, FillRule, inflatePaths, JoinType, union, type Paths64, type Point64 } from "clipper2-ts";
import { contourPoint, curveDistance, trimContourCurve, type ContourCurve, type ContourPoint } from "./contour";
import { findAdaptiveDetour } from "./adaptiveDetour";
import { POCKET_INTEGER_SCALE as SCALE } from "./pocketRegions";

const distance = (a: ContourPoint, b: ContourPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const GRID_MARGIN = 6;
const MAX_SWEEP_POINTS = 60_000;
const MAX_ROUTE_PROBES = 2500;
const MAX_ROUTE_SEARCHES = 40;

type LinkKind = "clear" | "cut";
interface Link {
  cut: readonly ContourCurve[];
  kind: LinkKind;
  waypoints?: readonly ContourPoint[];
}

/** Check direct links and short cutting transitions against completed cuts at this depth. */
export function createAdaptiveLinkPlanner(
  origin: ContourPoint, cutterRadius: number, walls: readonly ContourCurve[], targetArea: number,
) {
  const integer = ([x, y]: ContourPoint) => ({ x: Math.round((x - origin[0]) * SCALE), y: Math.round((y - origin[1]) * SCALE) });
  const radius = cutterRadius * SCALE;
  const arcTolerance = Math.max(1, radius / 1000);
  const clearedRadius = Math.floor(radius - arcTolerance - GRID_MARGIN);
  const linkRadius = Math.ceil(radius + arcTolerance + GRID_MARGIN);
  let remainingPoints = MAX_SWEEP_POINTS;
  let routeProbes = MAX_ROUTE_PROBES;
  let routeSearches = MAX_ROUTE_SEARCHES;
  let previous: ContourPoint | undefined;
  let cleared: Paths64 = [];
  let lastLines: Extract<ContourCurve, { kind: "line" }>[] = [];

  function remainingSweep(from: Point64, to: Point64) {
    const sweep = inflatePaths([[from, to]], linkRadius, JoinType.Round, EndType.Round, 2, arcTolerance);
    return sweep.length ? difference(sweep, cleared, FillRule.NonZero) : undefined;
  }

  function detour(cut: readonly ContourCurve[], to: ContourPoint): Link | undefined {
    if (!previous || !cleared.length || routeProbes <= 0 || routeSearches-- <= 0) return;
    const from = integer(previous);
    const path = findAdaptiveDetour(from, integer(to), cleared, linkRadius, arcTolerance,
      (a, b) => routeProbes-- > 0 && remainingSweep(a, b)?.length === 0);
    if (path) return {
      cut, kind: "clear", waypoints: path.map(({ x, y }) => [origin[0] + x / SCALE, origin[1] + y / SCALE]),
    };
  }

  function classify(to: ContourPoint): LinkKind | undefined {
    if (!previous) return;
    const from = previous;
    const span = distance(from, to);
    if (span <= 1e-9) return "clear";
    // A collinear subsegment of a completed straight cut is exactly clear,
    // including endpoints where an inward polygon approximation loses coverage.
    if (lastLines.some(({ a, b }) => {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      return [from, to].every(([x, y]) => {
        const px = x - a[0], py = y - a[1];
        const dot = dx * px + dy * py;
        return dx * py === dy * px && dot >= 0 && dot <= dx ** 2 + dy ** 2;
      });
    })) return "clear";
    if (!cleared.length) return;
    const remaining = remainingSweep(integer(from), integer(to));
    if (!remaining) return;
    if (!remaining.length) return "clear";
    // The fresh area of the entire short sweep bounds that at any tool
    // position along it. This is a feed cut with its own wall check.
    if (span <= cutterRadius && areaPaths(remaining) <= targetArea * radius ** 2
      && walls.every((wall) => curveDistance({ kind: "line", a: from, b: to }, wall) >= cutterRadius - 1e-7)) {
      return "cut";
    }
  }

  function choose(cut: readonly ContourCurve[]): Link | undefined {
    const start = contourPoint(cut[0]!, 0);
    const initial = classify(start);
    if (initial === "clear") return { cut, kind: initial };
    let cutting = initial === "cut" ? cut : undefined;
    if (!previous || distance(start, contourPoint(cut.at(-1)!, 1)) > 1e-7) {
      return cutting ? { cut: cutting, kind: "cut" } : detour(cut, start);
    }
    const from = previous;
    const seams = cut.flatMap((curve, index) => [0, 0.5].map((t) => ({ index, t, point: contourPoint(curve, t) })))
      .sort((a, b) => distance(from, a.point) - distance(from, b.point)).slice(0, 8);
    for (const { index, t, point } of seams) {
      const kind = classify(point);
      if (!kind || (kind === "cut" && cutting)) continue;
      const edge = cut[index]!;
      const rotated = t === 0 ? [...cut.slice(index), ...cut.slice(0, index)]
        : [trimContourCurve(edge, t, 1), ...cut.slice(index + 1), ...cut.slice(0, index), trimContourCurve(edge, 0, t)];
      if (kind === "clear") return { cut: rotated, kind };
      cutting = rotated;
    }
    return cutting ? { cut: cutting, kind: "cut" } : detour(cut, start);
  }

  function record(cut: readonly ContourCurve[]) {
    previous = contourPoint(cut.at(-1)!, 1);
    lastLines = cut.filter((curve) => curve.kind === "line");
    if (clearedRadius <= 0 || remainingPoints <= 0) return;
    const points = [];
    for (const curve of cut) {
      // Limit chord error to the part of the cutter radius removed from the mask.
      const count = curve.kind === "line" ? 1 : Math.ceil(Math.abs(curve.sweep) /
        (2 * Math.acos(Math.max(-1, 1 - arcTolerance / (curve.r * SCALE)))));
      remainingPoints -= count;
      if (remainingPoints < 0) return;
      for (let i = 0; i < count; i++) points.push(integer(contourPoint(curve, i / count)));
    }
    points.push(integer(previous));
    const swept = inflatePaths([points], clearedRadius, JoinType.Round, EndType.Round, 2, arcTolerance);
    cleared = union([...cleared, ...swept], FillRule.NonZero);
  }

  return { choose, record };
}
