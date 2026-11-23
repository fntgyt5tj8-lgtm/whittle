import type { CamFrame } from "../geometry/frames";
import type { CamResult, PocketMillingSettings } from "../model";
import { buildPlanarPreview, contourPoint, planMillingDepths,
  type ContourCurve, type ContourPoint, type ContourPreview } from "./contour";
import { offsetPocket, pocketBoundaries, POCKET_OFFSET_EDGE_LIMIT } from "./pocketRegions";

const EPS = 1e-5;
const MAX_SWEEPS = 500;
const fail = (message: string): CamResult<never> => ({ ok: false, errors: [message] });

function linePath(points: readonly ContourPoint[]): ContourCurve[] {
  const curves: ContourCurve[] = [];
  let from = points[0]!;
  for (const to of points.slice(1)) {
    if (Math.hypot(to[0] - from[0], to[1] - from[1]) <= 1e-7) continue;
    curves.push({ kind: "line", a: from, b: to });
    from = to;
  }
  return curves;
}

function interpolate(a: ContourPoint, b: ContourPoint, t: number): ContourPoint {
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

function polygonPocket(curves: readonly ContourCurve[], radius: number, step: number) {
  const vertices = curves.map((curve) => contourPoint(curve, 0));
  const origin = vertices[0]!;
  const area = vertices.reduce((sum, a, i) => {
    const b = vertices[(i + 1) % vertices.length]!;
    return sum + (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
  }, 0);
  if (!Number.isFinite(area) || Math.abs(area) <= EPS ** 2) return fail("The pocket boundary needs a positive area.");

  let inset = vertices;
  for (const [i, a] of vertices.entries()) {
    const b = vertices[(i + 1) % vertices.length]!;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const factor = Math.sign(area) / Math.hypot(dx, dy);
    const signedDistance = ([x, y]: ContourPoint) => factor * (dx * (y - a[1]) - dy * (x - a[0]));
    if (vertices.some((point) => signedDistance(point) < -1e-7)) {
      return undefined;
    }
    // Intersect the cutter-center region with each wall's inward half-plane.
    inset = inset.flatMap((p, j) => {
      const q = inset[(j + 1) % inset.length]!;
      const dp = signedDistance(p) - radius, dq = signedDistance(q) - radius;
      const crossing = (dp < 0 && dq > 0) || (dp > 0 && dq < 0);
      return [...(dp >= 0 ? [p] : []), ...(crossing ? [interpolate(p, q, dp / (dp - dq))] : [])];
    });
  }
  if (inset.length < 3) return fail("The cutter does not fit inside this pocket.");
  const minY = Math.min(...inset.map((p) => p[1])), maxY = Math.max(...inset.map((p) => p[1]));
  const minX = Math.min(...inset.map((p) => p[0])), maxX = Math.max(...inset.map((p) => p[0]));
  const swapAxes = maxX - minX < maxY - minY;
  const across = swapAxes ? 0 : 1, along = swapAxes ? 1 : 0;
  const low = swapAxes ? minX : minY, high = swapAxes ? maxX : maxY;
  if (high - low <= EPS) return fail("The cutter does not fit inside this pocket.");
  const count = Math.ceil((high - low) / step);
  if (count > MAX_SWEEPS) return fail("The pocket needs too many clearing rows. Increase the stepover or use a larger cutter.");

  const points: ContourPoint[] = [];
  for (let i = 0; i < count; i++) {
    const ordinate = low + ((i + 0.5) / count) * (high - low);
    const hits = inset.flatMap((a, j) => {
      const b = inset[(j + 1) % inset.length]!;
      const da = a[across] - ordinate, db = b[across] - ordinate;
      if ((da > 0) === (db > 0)) return [];
      return [interpolate(a, b, da / (da - db))];
    }).sort((a, b) => a[along] - b[along]);
    if (hits.length < 2) return fail("The pocket is too small to generate a clearing row.");
    const left = hits[0]!, right = hits.at(-1)!;
    points.push(...(i % 2 === 0 ? [left, right] : [right, left]));
  }
  const wall = [...inset, inset[0]!];
  const cut = linePath([...points, ...wall]);
  if (!cut.length) return fail("The cutter does not fit inside this pocket.");
  return { ok: true as const, value: { wall: linePath(wall), cut } };
}

function circularPocket(circle: Extract<ContourCurve, { kind: "arc" }>, radius: number, step: number) {
  const outer = circle.r - radius;
  if (outer <= EPS) return fail("The cutter does not fit inside this pocket.");
  const count = Math.ceil(outer / step);
  if (count > MAX_SWEEPS) return fail("The pocket needs too many clearing rings. Increase the stepover or use a larger cutter.");
  const radii = Array.from({ length: count }, (_, i) => outer * ((i + 1) / count));
  return { ok: true as const, value: circularClearing(circle, radii) };
}

export function circularClearing(circle: Extract<ContourCurve, { kind: "arc" }>, radii: readonly number[]) {
  const cut: ContourCurve[] = [];
  let start = circle.c;
  for (const r of radii) {
    const ring = { ...circle, r };
    const end = contourPoint(ring, 0);
    cut.push({ kind: "line", a: start, b: end }, ring);
    start = contourPoint(ring, 1);
  }
  return { wall: [{ ...circle, r: radii.at(-1)! }], cut };
}

export function generatePocket(
  input: readonly ContourCurve[], sketch: CamFrame, setup: CamFrame, settings: PocketMillingSettings, diameter: number,
  islandCurves: readonly ContourCurve[] = [], outputFrame = setup,
): CamResult<ContourPreview> {
  const depths = planMillingDepths(sketch, setup, settings, diameter);
  if (!depths.ok) return depths;
  const stepover = Number(settings.stepover);
  if (!Number.isFinite(stepover) || stepover <= 0 || stepover > 50) {
    return fail("Enter a pocket stepover greater than 0 and at most 50% of the cutter diameter.");
  }
  const boundaries = pocketBoundaries(input);
  if (!boundaries.ok) return boundaries;
  const islands = islandCurves.length ? pocketBoundaries(islandCurves) : undefined;
  if (islands && !islands.ok) return islands;
  const islandLoops = islands?.value ?? [];
  const loops = [...boundaries.value, ...islandLoops];
  const curves = loops[0]!;
  const first = curves[0]!;
  const radius = diameter / 2, step = diameter * (stepover / 100);
  const simple = loops.length !== 1 ? undefined
    : curves.length === 1 && first.kind === "arc" && Math.abs(first.sweep) >= 2 * Math.PI - 1e-12
      ? circularPocket(first, radius, step)
      : curves.every((curve) => curve.kind === "line") ? polygonPocket(curves, radius, step) : undefined;
  const clearance = Number(settings.clearance);
  if (simple) {
    if (!simple.ok) return simple;
    return buildPlanarPreview(loops, simple.value.wall, [simple.value.cut], sketch, setup, depths.value, clearance, undefined, undefined, outputFrame);
  }

  let pocket = offsetPocket(loops, radius, step, undefined, islandLoops.length);
  for (const tolerance of [0.001, 0.002]) {
    if (pocket.ok || !pocket.errors.includes(POCKET_OFFSET_EDGE_LIMIT)) break;
    pocket = offsetPocket(loops, radius, step, tolerance, islandLoops.length);
  }
  if (!pocket.ok) return pocket;
  return buildPlanarPreview(loops, pocket.value.wall, pocket.value.levels.flat(), sketch, setup, depths.value, clearance, undefined, undefined, outputFrame);
}
