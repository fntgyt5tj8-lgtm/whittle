import { CAM_WORLD, cross as cross3, dot, subtract, isCamFrame, transformCamVector, unit as unitVector, type CamFrame, type CamVector } from "../geometry/frames";
import { CAM_LENGTH_TOLERANCE } from "../toolpath/validation";
import type { CamMotion } from "../toolpath/model";
import type { CamResult, ContourMillingSettings, MillingDepthSettings } from "../model";

export type ContourPoint = readonly [number, number];
interface Line { readonly kind: "line"; readonly a: ContourPoint; readonly b: ContourPoint }
interface Arc { readonly kind: "arc"; readonly c: ContourPoint; readonly r: number; readonly start: number; readonly sweep: number }
export type ContourCurve = Line | Arc;

const EPS = 1e-5;
const TAU = 2 * Math.PI;
const add = (a: ContourPoint, b: ContourPoint): ContourPoint => [a[0] + b[0], a[1] + b[1]];
const sub = (a: ContourPoint, b: ContourPoint): ContourPoint => [a[0] - b[0], a[1] - b[1]];
const scale = (a: ContourPoint, k: number): ContourPoint => [a[0] * k, a[1] * k];
const dot2 = (a: ContourPoint, b: ContourPoint) => a[0] * b[0] + a[1] * b[1];
const cross = (a: ContourPoint, b: ContourPoint) => a[0] * b[1] - a[1] * b[0];
const length = (a: ContourPoint) => Math.hypot(...a);
const unit = (a: ContourPoint) => scale(a, 1 / length(a));
const angle = (a: ContourPoint) => Math.atan2(a[1], a[0]);
const polar = (a: number): ContourPoint => [Math.cos(a), Math.sin(a)];
const left = (a: ContourPoint): ContourPoint => [-a[1], a[0]];
const ccw = (a: number) => ((a % TAU) + TAU) % TAU;
const near = (a: ContourPoint, b: ContourPoint, tolerance = EPS) => length(sub(a, b)) <= tolerance;
const fail = (message: string): CamResult<never> => ({ ok: false, errors: [message] });

export function contourPoint(curve: ContourCurve, t: number): ContourPoint {
  return curve.kind === "line" ? add(curve.a, scale(sub(curve.b, curve.a), t))
    : add(curve.c, scale(polar(curve.start + t * curve.sweep), curve.r));
}

function curveLength(curve: ContourCurve) {
  return curve.kind === "line" ? length(sub(curve.b, curve.a)) : curve.r * Math.abs(curve.sweep);
}

function tangent(curve: ContourCurve, t: number) {
  return curve.kind === "line" ? unit(sub(curve.b, curve.a))
    : scale(left(polar(curve.start + t * curve.sweep)), Math.sign(curve.sweep));
}

function reverse(curve: ContourCurve): ContourCurve {
  return curve.kind === "line" ? { kind: "line", a: curve.b, b: curve.a }
    : { ...curve, start: curve.start + curve.sweep, sweep: -curve.sweep };
}

function parameter(curve: ContourCurve, p: ContourPoint, tolerance = EPS) {
  if (curve.kind === "line") {
    const d = sub(curve.b, curve.a);
    return dot2(sub(p, curve.a), d) / dot2(d, d);
  }
  if (near(p, contourPoint(curve, 0), tolerance)) return 0;
  if (near(p, contourPoint(curve, 1), tolerance)) return 1;
  return ccw((angle(sub(p, curve.c)) - curve.start) * Math.sign(curve.sweep)) / Math.abs(curve.sweep);
}

function onCurve(curve: ContourCurve, p: ContourPoint, tolerance = EPS) {
  const t = parameter(curve, p, tolerance);
  return near(p, contourPoint(curve, Math.max(0, Math.min(1, t))), tolerance);
}

function lineCircle(line: Line, arc: Arc): ContourPoint[] {
  const d = unit(sub(line.b, line.a));
  const foot = add(line.a, scale(d, dot2(sub(arc.c, line.a), d)));
  const distance = length(sub(foot, arc.c));
  if (distance > arc.r + EPS) return [];
  const delta = scale(d, Math.sqrt(Math.max(0, (arc.r - distance) * (arc.r + distance))));
  return [add(foot, delta), sub(foot, delta)];
}

function intersections(a: ContourCurve, b: ContourCurve): ContourPoint[] {
  if (a.kind === "line" && b.kind === "line") {
    const u = unit(sub(a.b, a.a)), v = unit(sub(b.b, b.a));
    const det = cross(u, v);
    return Math.abs(det) < 1e-12 ? [] : [add(a.a, scale(u, cross(sub(b.a, a.a), v) / det))];
  }
  if (a.kind === "line" && b.kind === "arc") return lineCircle(a, b);
  if (a.kind === "arc" && b.kind === "line") return lineCircle(b, a);
  if (a.kind !== "arc" || b.kind !== "arc") return [];
  const offset = sub(b.c, a.c), d = length(offset);
  if (d < EPS || d > a.r + b.r || d < Math.abs(a.r - b.r)) return [];
  const x = (d ** 2 + a.r ** 2 - b.r ** 2) / (2 * d);
  const u = unit(offset);
  const p = add(a.c, scale(u, x)), delta = scale(left(u), Math.sqrt(Math.max(0, a.r ** 2 - x ** 2)));
  return [add(p, delta), sub(p, delta)];
}

function intersectsExcept(a: ContourCurve, b: ContourCurve, shared: readonly ContourPoint[]) {
  const unshared = (p: ContourPoint) => !shared.some((q) => near(q, p));
  // An intersection of the infinite supports must lie on both finite curves.
  // Using the join tolerance here extends both ends into short connector arcs.
  if (intersections(a, b).some((p) => {
    const tolerance = 32 * Number.EPSILON * Math.max(1, length(p), curveLength(a), curveLength(b));
    return onCurve(a, p, tolerance) && onCurve(b, p, tolerance) && unshared(p);
  })) return true;

  // Endpoints and midpoints reveal coincident spans, which have no isolated roots.
  return [0, 0.5, 1].some((t) => {
    const pa = contourPoint(a, t), pb = contourPoint(b, t);
    return (onCurve(b, pa) && unshared(pa)) || (onCurve(a, pb) && unshared(pb));
  });
}

function simple(curves: readonly ContourCurve[], closed: boolean) {
  return curves.every((a, i) => curves.slice(i + 1).every((b, j) => {
    const next = j === 0;
    const closing = closed && i === 0 && i + j + 1 === curves.length - 1;
    const shared: ContourPoint[] = [];
    if (next) shared.push(contourPoint(a, 1));
    if (closing) shared.push(contourPoint(a, 0));
    return !intersectsExcept(a, b, shared);
  }));
}

export function orderContour(input: readonly ContourCurve[]): CamResult<{ curves: ContourCurve[]; closed: boolean }> {
  if (!input.length) return fail("The sketch has no milling edges.");
  if (input.length > 500) return fail("A contour can contain up to 500 edges.");
  const nodes: { point: ContourPoint; edges: number[] }[] = [];
  function node(point: ContourPoint, edge: number) {
    const match = nodes.findIndex((n) => near(n.point, point));
    if (match < 0) {
      nodes.push({ point, edges: [edge] });
      return nodes.length - 1;
    }
    nodes[match]!.edges.push(edge);
    return match;
  }
  const ends: [number, number][] = [];
  for (const [i, curve] of input.entries()) {
    const a = contourPoint(curve, 0), b = contourPoint(curve, 1);
    const span = curveLength(curve);
    if (![...a, ...b, span].every(Number.isFinite) || span <= EPS
      || (curve.kind === "arc" && (curve.r <= EPS || Math.abs(curve.sweep) > TAU + 1e-12))) {
      return fail("The sketch contains a degenerate line or arc.");
    }
    ends.push([node(a, i), node(b, i)]);
  }
  const endpoints = nodes.flatMap((n, i) => n.edges.length === 1 ? [i] : []);
  if (nodes.some((n) => n.edges.length > 2) || ![0, 2].includes(endpoints.length)) {
    return fail("Choose one continuous contour without branches or disconnected edges.");
  }
  const closed = endpoints.length === 0;
  let at = endpoints[0] ?? ends[0]![0];
  const used = new Set<number>();
  const curves: ContourCurve[] = [];
  let followsFirstEdge = true;
  while (curves.length < input.length) {
    const i = nodes[at]!.edges.find((edge) => !used.has(edge));
    if (i === undefined) return fail("Choose one continuous contour without disconnected loops.");
    const [a, b] = ends[i]!;
    if (i === 0) followsFirstEdge = at === a;
    curves.push(at === a ? input[i]! : reverse(input[i]!));
    used.add(i);
    at = at === a ? b : a;
  }
  if (!simple(curves, closed)) return fail("The sketch contour crosses or overlaps itself.");
  return { ok: true, value: { curves: followsFirstEdge ? curves : curves.reverse().map(reverse), closed } };
}

function parallel(curve: ContourCurve, d: number): ContourCurve {
  if (curve.kind === "arc") return { ...curve, r: curve.r - Math.sign(curve.sweep) * d };
  const offset = scale(left(tangent(curve, 0)), d);
  return { kind: "line", a: add(curve.a, offset), b: add(curve.b, offset) };
}

export function trimContourCurve(curve: ContourCurve, lo: number, hi: number): ContourCurve {
  if (curve.kind === "line") return { kind: "line", a: contourPoint(curve, lo), b: contourPoint(curve, hi) };
  return { ...curve, start: curve.start + lo * curve.sweep, sweep: (hi - lo) * curve.sweep };
}

export function closestContourPoint(p: ContourPoint, curve: ContourCurve): ContourPoint {
  if (curve.kind === "arc") {
    const radial = add(curve.c, scale(polar(angle(sub(p, curve.c))), curve.r));
    if (onCurve(curve, radial)) return radial;
    const start = contourPoint(curve, 0), end = contourPoint(curve, 1);
    return length(sub(p, start)) <= length(sub(p, end)) ? start : end;
  }
  return contourPoint(curve, Math.max(0, Math.min(1, parameter(curve, p))));
}

const distanceToCurve = (p: ContourPoint, curve: ContourCurve) => length(sub(p, closestContourPoint(p, curve)));

/** Minima occur at ends, intersections, or points with parallel tangents. */
export function curveDistance(a: ContourCurve, b: ContourCurve) {
  if (intersections(a, b).some((p) => onCurve(a, p) && onCurve(b, p))) return 0;
  const distances = [0, 1].flatMap((t) => [distanceToCurve(contourPoint(a, t), b), distanceToCurve(contourPoint(b, t), a)]);
  for (const [arc, other] of [[a, b], [b, a]] as const) {
    if (arc.kind !== "arc") continue;
    const direction = other.kind === "line" ? left(tangent(other, 0)) : sub(other.c, arc.c);
    if (length(direction) < EPS) continue;
    for (const sign of [-1, 1]) {
      const p = add(arc.c, scale(unit(direction), sign * arc.r));
      if (onCurve(arc, p)) distances.push(distanceToCurve(p, other));
    }
  }
  return Math.min(...distances);
}

function offset(curves: readonly ContourCurve[], closed: boolean, d: number): CamResult<readonly ContourCurve[]> {
  if (d === 0) return { ok: true, value: curves };
  const shifted = curves.map((curve) => parallel(curve, d));
  if (shifted.some((curve) => curve.kind === "arc" && curve.r <= EPS)) {
    return fail("The cutter radius collapses an arc on this side of the contour.");
  }
  const limits = curves.map(() => ({ lo: 0, hi: 1 }));
  const joins = new Map<number, Arc>();
  for (let i = 0; i < curves.length - (closed && curves.length > 1 ? 0 : 1); i++) {
    const j = (i + 1) % curves.length;
    const a = shifted[i]!, b = shifted[j]!;
    const end = contourPoint(a, 1), start = contourPoint(b, 0);
    const u = tangent(a, 1), v = tangent(b, 0);
    if (dot2(u, v) < -1 + 1e-10) return fail("An offset cannot turn back at a cusp.");
    if (near(end, start)) continue;
    const turn = cross(u, v);
    if (turn * d < 0) {
      const center = contourPoint(curves[i]!, 1);
      joins.set(i, { kind: "arc", c: center, r: Math.abs(d), start: angle(sub(end, center)),
        sweep: Math.atan2(turn, dot2(u, v)) });
      continue;
    }
    const p = intersections(a, b).filter((p) => onCurve(a, p) && onCurve(b, p))
      .sort((p, q) => length(sub(p, end)) + length(sub(p, start)) - length(sub(q, end)) - length(sub(q, start)))[0];
    if (!p) return fail("The cutter does not fit at an inside corner on this side.");
    limits[i]!.hi = parameter(a, p);
    limits[j]!.lo = parameter(b, p);
  }
  if (limits.some(({ lo, hi }, i) => (hi - lo) * curveLength(shifted[i]!) <= EPS)) {
    return fail("The offset collapses a contour edge. Use a smaller cutter or change sides.");
  }
  const result = shifted.flatMap((curve, i) => {
    const { lo, hi } = limits[i]!;
    const segment = trimContourCurve(curve, lo, hi);
    const join = joins.get(i);
    return join ? [segment, join] : [segment];
  });
  const pairs = closed ? result : result.slice(0, -1);
  if (pairs.some((curve, i) => !near(contourPoint(curve, 1), contourPoint(result[(i + 1) % result.length]!, 0)))) {
    return fail("The compensated edges do not meet within the contour tolerance.");
  }
  if (!simple(result, closed) || result.some((a) => curves.some((b) => curveDistance(a, b) < Math.abs(d) - 2 * EPS))) {
    return fail("The offset crosses itself or cuts into another part of the contour. Use a smaller cutter or change sides.");
  }
  return { ok: true, value: result };
}

function makeLead(
  edge: ContourCurve, entry: boolean, tangentLength: number, normalLength: number,
  arcAngle: number, arcRadius: number, side: number,
): ContourCurve[] {
  const t = entry ? 0 : 1;
  const along = tangent(edge, t);
  const outward = scale(left(along), side || 1);
  const travel = entry ? -1 : 1;
  // Build from the contour outward, then reverse the sequence for entry.
  const lead: ContourCurve[] = [];
  let point = contourPoint(edge, t);
  if (tangentLength) {
    const end = add(point, scale(along, travel * tangentLength));
    lead.push({ kind: "line", a: point, b: end });
    point = end;
  }
  if (arcAngle) {
    const arc: Arc = { kind: "arc", c: add(point, scale(outward, arcRadius)), r: arcRadius,
      start: angle(scale(outward, -1)), sweep: arcAngle * Math.PI / 180 * (side || 1) * travel };
    lead.push(arc);
    point = contourPoint(arc, 1);
  }
  if (normalLength) lead.push({ kind: "line", a: point, b: add(point, scale(outward, normalLength)) });
  return entry ? lead.reverse().map(reverse) : lead;
}

export interface ContourEditHandle {
  readonly key: "leadIn" | "leadOut" | "seam";
  readonly position: CamVector;
  readonly normal: CamVector;
  readonly traceFrom: CamVector;
  project(point: CamVector): { value: number; position: CamVector; traceFrom: CamVector };
}

type ContourHandleSpec = {
  readonly sketch: CamFrame;
  readonly depth: number;
} & (
  | { readonly key: "seam"; readonly point: ContourPoint; readonly center: readonly ContourCurve[]; readonly clearance: number }
  | { readonly key: "leadIn" | "leadOut"; readonly endpoint: ContourPoint; readonly direction: ContourPoint; readonly extension: number }
);

export interface ContourPreviewData {
  readonly handles?: readonly ContourHandleSpec[];
  readonly segmentLengths: readonly number[];
  readonly programmed: readonly CamVector[];
  readonly adaptiveTransitionCuts?: number;
  readonly stayDownLinkCount?: number;
  readonly stayDownCutLinkCount?: number;
  readonly routedStayDownLinkCount?: number;
  readonly programmedPaths: readonly (readonly CamVector[])[];
  /** The full-depth compensated contour, without leads. */
  readonly centerline: readonly CamVector[];
  readonly cuttingPasses: readonly (readonly CamVector[])[];
  readonly entryPaths: readonly (readonly CamVector[])[];
  readonly linkingMoves: readonly (readonly [CamVector, CamVector])[];
  /** Neutral motions in the setup coordinate system. */
  readonly motions: readonly CamMotion[];
  readonly length: number;
  /** Reference frame for neutral motion coordinates. */
  readonly frame: CamFrame;
  /** Physical TIP orientation in world coordinates. */
  readonly toolFrame: CamFrame;
}

export interface ContourPreview extends ContourPreviewData {
  readonly contourHandles?: readonly ContourEditHandle[];
  pointAt(progress: number): CamVector;
}

function editHandle(spec: ContourHandleSpec): ContourEditHandle {
  const { sketch, depth, key } = spec;
  const at = (p: ContourPoint, z = depth) => transformCamVector([p[0], p[1], z], sketch, CAM_WORLD, "point");
  const planar = (p: CamVector): ContourPoint => {
    const [x, y] = transformCamVector(p, CAM_WORLD, sketch, "point");
    return [x, y];
  };
  if (key === "seam") {
    const { point, center, clearance } = spec;
    const lengths = center.map(curveLength);
    const total = lengths.reduce((sum, value) => sum + value, 0);
    return {
      key, position: at(point), normal: sketch.z, traceFrom: at(point, clearance),
      project(world) {
        const p = planar(world);
        let best = Infinity, along = 0, selected = point, fraction = 0;
        for (const [i, curve] of center.entries()) {
          const u = parameter(curve, p);
          for (const candidate of [0, 1, Math.max(0, Math.min(1, u))]) {
            const q = contourPoint(curve, candidate);
            const error = length(sub(p, q));
            if (error >= best) continue;
            best = error;
            selected = q;
            fraction = (along + lengths[i]! * candidate) / total;
          }
          along += lengths[i]!;
        }
        return { value: fraction === 1 ? 0 : fraction, position: at(selected), traceFrom: at(selected, clearance) };
      },
    };
  }
  const { endpoint, direction, extension } = spec;
  const traceFrom = at(endpoint);
  return {
    key, position: at(add(endpoint, scale(direction, extension))), normal: sketch.z, traceFrom,
    project(world) {
      const projected = dot2(sub(planar(world), endpoint), direction);
      const value = projected > EPS ? projected : 0;
      return { value, position: at(add(endpoint, scale(direction, value))), traceFrom };
    },
  };
}

function motionPoint(motion: CamMotion, t: number): CamVector {
  if (t <= 0) return motion.start;
  if (t >= 1) return motion.end;
  const { start, end } = motion;
  if (motion.kind === "line") return [
    start[0] + t * (end[0] - start[0]),
    start[1] + t * (end[1] - start[1]),
    start[2] + t * (end[2] - start[2]),
  ];
  const radial = subtract(start, motion.center);
  const target = subtract(end, motion.center);
  const normal = motion.normal;
  const tangent = cross3(normal, radial);
  const angle = Math.atan2(dot(tangent, target), dot(radial, target));
  const sweep = motion.direction === "ccw" ? ccw(angle) : -ccw(-angle);
  const axial = motion.helical ? dot(target, normal) : 0;
  const cos = Math.cos(sweep * t), sin = Math.sin(sweep * t);
  const coordinate = (i: 0 | 1 | 2) => motion.center[i] + radial[i] * cos + tangent[i] * sin + normal[i] * axial * t;
  return [coordinate(0), coordinate(1), coordinate(2)];
}

export function restoreContourPreview(data: ContourPreviewData): ContourPreview {
  let total = 0;
  const ends = data.segmentLengths.map((length) => total += length);
  return {
    ...data,
    contourHandles: data.handles?.map(editHandle),
    pointAt(progress) {
      const distance = Math.max(0, Math.min(1, progress)) * total;
      let lo = 0, hi = ends.length - 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (ends[mid]! < distance) lo = mid + 1;
        else hi = mid;
      }
      const length = data.segmentLengths[lo]!;
      const t = distance >= ends[lo]! ? 1 : (distance - (ends[lo - 1] ?? 0)) / length;
      return transformCamVector(motionPoint(data.motions[lo]!, t), data.frame, CAM_WORLD, "point");
    },
  };
}

export function contourPreviewData({ contourHandles, pointAt, ...data }: ContourPreview): ContourPreviewData {
  return data;
}

export function planMillingDepths(
  sketch: CamFrame, setup: CamFrame, settings: MillingDepthSettings, diameter: number,
): CamResult<readonly number[]> {
  if (!isCamFrame(sketch) || !isCamFrame(setup) || dot(sketch.z, setup.z) < 1 - 1e-10) {
    return fail("The sketch normal must point along the setup's positive Z axis for 2.5D milling.");
  }
  if (!Number.isFinite(diameter) || diameter <= 0) return fail("The cutting component needs a positive inherited CUTTER_DIAMETER.");
  const depth = Number(settings.depth), clearance = Number(settings.clearance);
  if (!Number.isFinite(depth + clearance) || depth <= 0 || clearance <= 0) {
    return fail("Enter positive machining depth and clearance in millimetres.");
  }
  const stepdown = settings.stepdown?.trim() ? Number(settings.stepdown) : depth;
  if (!Number.isFinite(stepdown) || stepdown <= 0) return fail("Enter a positive maximum stepdown or leave it blank.");
  const ratio = depth / stepdown;
  const passCount = Math.max(1, Math.ceil(ratio - Number.EPSILON * ratio));
  if (!Number.isFinite(passCount) || passCount > 500) return fail("Increase maximum stepdown to generate at most 500 depth passes.");
  return { ok: true, value: Array.from({ length: passCount }, (_, i) =>
    i + 1 === passCount ? -depth : -(i + 1) * stepdown) };
}

/** Resolve travel relative to the saved contour direction without moving the compensated path to the other side. */
export function contourTravel(settings: ContourMillingSettings) {
  const { side, millingDirection, spindleDirection = "cw" } = settings;
  if (side === "center" || !millingDirection || millingDirection === "manual") {
    return { side, reversed: false };
  }
  const travelSide = (spindleDirection === "cw") === (millingDirection === "climb") ? "left" : "right";
  return { side: travelSide, reversed: side !== travelSide } as const;
}

export function generateContour(
  input: readonly ContourCurve[], sketch: CamFrame, setup: CamFrame,
  settings: ContourMillingSettings, diameter: number, outputFrame = setup,
): CamResult<ContourPreview> {
  const depths = planMillingDepths(sketch, setup, settings, diameter);
  if (!depths.ok) return depths;
  const leadIn = Number(settings.leadIn ?? 0), leadOut = Number(settings.leadOut ?? 0);
  const normalIn = Number(settings.normalLeadIn ?? 0), normalOut = Number(settings.normalLeadOut ?? 0);
  const arcIn = Number(settings.arcLeadIn ?? 0), arcOut = Number(settings.arcLeadOut ?? 0);
  if (![leadIn, leadOut, normalIn, normalOut].every((value) => Number.isFinite(value) && (value === 0 || value > EPS))) {
    return fail("Enter zero or a positive lead length greater than the contour tolerance.");
  }
  const arcInRadius = settings.arcLeadInRadius?.trim() ? Number(settings.arcLeadInRadius) : diameter / 2;
  const arcOutRadius = settings.arcLeadOutRadius?.trim() ? Number(settings.arcLeadOutRadius) : diameter / 2;
  for (const [sweep, radius] of [[arcIn, arcInRadius], [arcOut, arcOutRadius]] as const) {
    if (!Number.isFinite(sweep) || sweep < 0 || sweep > 180) return fail("Enter a tangent arc angle between 0° and 180°.");
    if (sweep > 0 && (!Number.isFinite(radius) || radius <= EPS || sweep * Math.PI / 180 * radius <= EPS)) {
      return fail("Enter a positive tangent arc radius that gives a move longer than the contour tolerance.");
    }
  }
  const chain = orderContour(input);
  if (!chain.ok) return chain;
  const { closed } = chain.value;
  const curves = settings.direction === "reverse" ? chain.value.curves.slice().reverse().map(reverse) : chain.value.curves;
  const side = settings.side === "left" ? 1 : settings.side === "right" ? -1 : 0;
  const seam = Number(settings.seam ?? 0);
  if (closed && (!Number.isFinite(seam) || seam < 0 || seam > 1)) {
    return fail("Enter a seam fraction between 0 and 1.");
  }
  const travel = contourTravel(settings);
  const stock = Number(settings.stockAllowance ?? 0);
  const increment = Number(settings.radialIncrement ?? 0);
  const finishStock = increment ? Number(settings.finishAllowance ?? 0) : stock;
  if (![stock, increment, finishStock].every((value) => Number.isFinite(value) && value >= 0)) {
    return fail("Enter nonnegative radial stock, increment and finish allowance values.");
  }
  if (side === 0 && (stock || increment || finishStock)) {
    return fail("Select a left or right machining side for radial stock allowance and passes.");
  }
  if (finishStock > stock) return fail("Finish allowance must be at most the starting stock allowance.");
  if (increment > 0 && increment <= CAM_LENGTH_TOLERANCE) {
    return fail("Enter a radial increment greater than the toolpath tolerance.");
  }
  const ratio = increment ? (stock - finishStock) / increment : 0;
  const roughCount = Math.ceil(ratio - Number.EPSILON * ratio);
  if (!Number.isFinite(roughCount) || (roughCount + 1) * depths.value.length > 500) {
    return fail("Increase radial increment or stepdown to generate at most 500 total contour passes.");
  }

  function planPass(allowance: number) {
    const radius = side * (diameter / 2 + allowance);
    const center = offset(curves, closed, radius);
    if (!center.ok) return center;
    const lengths = center.value.map(curveLength);
    const total = lengths.reduce((sum, span) => sum + span, 0);
    const requested = closed && seam < 1 ? seam * total : 0;
    let index = 0;
    let distance = requested;
    while (index < lengths.length - 1 && distance >= lengths[index]!) distance -= lengths[index++]!;
    const span = lengths[index]!;
    if (span - distance <= CAM_LENGTH_TOLERANCE) {
      index = (index + 1) % lengths.length;
      distance = 0;
    }
    const t = distance <= CAM_LENGTH_TOLERANCE ? 0 : distance / span;
    const seamCurve = center.value[index]!;
    const fromSeam = t === 0
      ? [...center.value.slice(index), ...center.value.slice(0, index)]
      : [trimContourCurve(seamCurve, t, 1), ...center.value.slice(index + 1),
        ...center.value.slice(0, index), trimContourCurve(seamCurve, 0, t)];
    const ordered = travel.reversed ? fromSeam.reverse().map(reverse) : fromSeam;
    const leadSide = travel.reversed ? -side : side;
    const first = ordered[0]!, last = ordered.at(-1)!;
    const entry = makeLead(first, true, leadIn, normalIn, arcIn, arcInRadius, leadSide);
    const exit = makeLead(last, false, leadOut, normalOut, arcOut, arcOutRadius, leadSide);
    for (const [lead, label, contact, adjacent] of [
      [entry, "Lead-in", contourPoint(first, 0), entry.length - 1],
      [exit, "Lead-out", contourPoint(last, 1), 0],
    ] as const) {
      if (!simple(lead, false) || lead.some((move, i) =>
        center.value.some((curve) => intersectsExcept(move, curve, i === adjacent ? [contact] : []))
        || (side !== 0 && curves.some((curve) => curveDistance(move, curve) < Math.abs(radius) - 2 * EPS)))) {
        return fail(`${label} crosses the toolpath or gouges the contour. Shorten it or set it to zero.`);
      }
    }

    const cut: ContourCurve[] = [];
    for (const curve of [...entry, ...ordered, ...exit]) {
      const previous = cut.at(-1);
      if (previous) {
        const a = contourPoint(previous, 1), b = contourPoint(curve, 0);
        // The contour join tolerance is larger than the motion continuity tolerance.
        // Emit the short feed move explicitly so both adjoining curves keep their geometry.
        if (!near(a, b, CAM_LENGTH_TOLERANCE)) {
          if (!near(a, b)) return fail("The compensated edges do not meet within the contour tolerance.");
          const connector: Line = { kind: "line", a, b };
          if (side !== 0 && curves.some((edge) => curveDistance(connector, edge) < Math.abs(radius) - 2 * EPS)) {
            return fail("The offset crosses itself or cuts into another part of the contour. Use a smaller cutter or change sides.");
          }
          cut.push(connector);
        }
      }
      cut.push(curve);
    }
    return { ok: true, value: { center: center.value, lengths, total, seamCurve, t, ordered, cut } } as const;
  }

  const cuts: ContourCurve[][] = [];
  for (let i = 0; i < roughCount; i++) {
    const allowance = stock - i * increment;
    const pass = planPass(allowance);
    if (!pass.ok) return fail(`Radial pass at ${allowance.toPrecision(8)} mm allowance. ${pass.errors.join(" ")}`);
    cuts.push(pass.value.cut);
  }
  const finish = planPass(finishStock);
  if (!finish.ok) return finish;
  const { center, lengths, total, seamCurve, t, ordered, cut } = finish.value;
  cuts.push(cut);
  const first = ordered[0]!, last = ordered.at(-1)!;
  const clearance = Number(settings.clearance);
  const programmed = travel.reversed ? curves.slice().reverse().map(reverse) : curves;
  const stayDown = settings.optimiseRetracts ? cuts.map((next, index) => {
    const previous = cuts[index - 1];
    if (!previous) return;
    const a = contourPoint(previous.at(-1)!, 1), b = contourPoint(next[0]!, 0);
    const distance = length(sub(b, a));
    if (distance <= CAM_LENGTH_TOLERANCE || distance > diameter) return;
    const allowance = index === cuts.length - 1 ? finishStock : stock - index * increment;
    const required = diameter / 2 + allowance;
    const link: Line = { kind: "line", a, b };
    if (curves.some((edge) => curveDistance(link, edge) < required - 2 * EPS)) return;
    return []; // The direct route needs no intermediate points.
  }) : undefined;
  const preview = buildPlanarPreview([programmed], ordered, cuts, sketch, setup, depths.value, clearance, undefined, stayDown, outputFrame);
  if (!preview.ok) return preview;
  const depth = depths.value.at(-1)!;
  const handles: ContourHandleSpec[] = closed
    ? [{ key: "seam", sketch, depth, point: contourPoint(seamCurve, t), center, clearance }]
    : ([
      ["leadIn", first, 0, leadIn], ["leadOut", last, 1, leadOut],
    ] as const).map(([key, curve, u, extension]) => ({
      key, sketch, depth, extension, endpoint: contourPoint(curve, u),
      direction: scale(tangent(curve, u), u === 0 ? -1 : 1),
    }));
  const stayDownLinkCount = stayDown && stayDown.filter(Boolean).length * depths.value.length;
  return { ok: true, value: restoreContourPreview({ ...contourPreviewData(preview.value), handles, stayDownLinkCount }) };
}

export interface HelixEntry {
  readonly center: ContourPoint;
  readonly start: ContourPoint;
  readonly pitch: number;
  readonly direction: "cw" | "ccw";
}

export function buildPlanarPreview(
  boundaries: readonly (readonly ContourCurve[])[], centerline: readonly ContourCurve[], cuts: readonly (readonly ContourCurve[])[],
  sketch: CamFrame, setup: CamFrame, depths: readonly number[], clearance: number, entries?: readonly (HelixEntry | undefined)[],
  stayDown?: readonly (readonly ContourPoint[] | undefined)[], outputFrame = setup,
): CamResult<ContourPreview> {
  if (!isCamFrame(outputFrame)) return fail("The output coordinate system is invalid.");
  const outputPoint = (point: CamVector) => transformCamVector(point, setup, outputFrame, "point");
  const outputAxis = unitVector(transformCamVector(CAM_WORLD.z, setup, outputFrame, "direction"));
  const sketchZ = sketch === setup ? 0 : transformCamVector(CAM_WORLD.origin, sketch, setup, "point")[2];
  const toolAxis = CAM_WORLD.z;
  function at(p: ContourPoint, height: number): CamVector {
    if (sketch === setup) return [p[0], p[1], height];
    const [x, y] = transformCamVector([p[0], p[1], 0], sketch, setup, "point");
    return [x, y, sketchZ + height];
  }
  const world = (p: CamVector) => transformCamVector(p, setup, CAM_WORLD, "point");
  const toSamples = (curve: ContourCurve) => curve.kind === "arc" ? Math.min(2048, Math.ceil(Math.abs(curve.sweep)
    / Math.min(Math.PI / 24, Math.sqrt(0.08 / curve.r)))) : 1;
  if (depths.length * cuts.reduce((sum, cut) => sum + cut.reduce((n, curve) => n + toSamples(curve), 0), 0) > 500_000) {
    return fail("The milling preview is too large. Reduce the number of edges or passes.");
  }
  function sample(path: readonly ContourCurve[], height: number) {
    return path.flatMap((curve, i) => {
      const count = toSamples(curve);
      const first = i === 0 ? 0 : 1;
      return Array.from({ length: count + 1 - first },
        (_, j) => world(at(contourPoint(curve, (j + first) / count), height)));
    });
  }

  const motions: CamMotion[] = [];
  const entryPaths: CamVector[][] = [];
  const linkingMoves: [CamVector, CamVector][] = [];
  const cuttingPasses: CamVector[][] = [];
  const segmentLengths: number[] = [];
  let travel = 0;
  function append(motion: CamMotion, length: number) {
    travel += length;
    segmentLengths.push(length);
    if (outputFrame === setup) {
      motions.push(motion);
    } else {
      const endpoints = { start: outputPoint(motion.start), end: outputPoint(motion.end), toolAxis: outputAxis };
      motions.push(motion.kind === "line" ? { ...motion, ...endpoints }
        : { ...motion, ...endpoints, center: outputPoint(motion.center), normal: outputAxis });
    }
  }
  function link(start: CamVector, end: CamVector, mode: "feed" | "plunge" | "rapid" | "link") {
    const delta = end.map((v, i) => v - start[i]!);
    const span = Math.hypot(...delta);
    if (span <= CAM_LENGTH_TOLERANCE && start[2] === end[2]) return;
    linkingMoves.push([world(start), world(end)]);
    append({ kind: "line", mode, start, end, toolAxis }, span);
  }
  const chains = cuts.map((cut) => ({
    cut,
    start: contourPoint(cut[0]!, 0),
    end: contourPoint(cut.at(-1)!, 1),
    // Neutral arcs have distinct endpoints, so a whole circle needs two commands.
    curves: cut.flatMap((curve) => curve.kind === "arc" && Math.abs(curve.sweep) >= TAU - 1e-12
      ? [trimContourCurve(curve, 0, 0.5), trimContourCurve(curve, 0.5, 1)] : [curve]),
  }));
  let previous: ContourPoint | undefined;
  let surface = 0;
  let entrySamples = 0;
  for (const height of depths) {
    for (const [i, { cut, start, end, curves }] of chains.entries()) {
      const entry = entries?.[i];
      const approach = entry?.start ?? start;
      const route = stayDown?.[i];
      if (i > 0 && route) {
        let from = previous!;
        for (const to of [...route, start]) {
          link(at(from, height), at(to, height), "link");
          from = to;
        }
      } else {
        if (i > 0) link(at(previous!, height), at(previous!, clearance), "rapid");
        if (previous) link(at(previous, clearance), at(approach, clearance), "rapid");
        if (entry) {
          const turns = Math.ceil((surface - height) / entry.pitch);
          const radius = length(sub(entry.start, entry.center));
          const count = toSamples({ kind: "arc", c: entry.center, r: radius, start: 0, sweep: Math.PI });
          entrySamples += (count + 1) * turns * 2;
          if (!Number.isFinite(turns) || turns > 500 || entrySamples > 150_000) {
            return fail("Helical entry needs too many turns. Increase its diameter or ramp angle, or reduce stepdown.");
          }
          link(at(approach, clearance), at(approach, surface), "plunge");
          const opposite = sub(scale(entry.center, 2), entry.start);
          const sweep = entry.direction === "ccw" ? Math.PI : -Math.PI;
          const drop = (surface - height) / (turns * 2);
          if (drop <= CAM_LENGTH_TOLERANCE) return fail("The depth increment is too small for a helical entry.");
          const trace = [world(at(approach, surface))];
          for (let half = 0; half < turns * 2; half++) {
            const a = half % 2 === 0 ? entry.start : opposite;
            const b = half % 2 === 0 ? opposite : entry.start;
            const z = surface - half * drop;
            const nextZ = half + 1 === turns * 2 ? height : surface - (half + 1) * drop;
            const arc: Arc = { kind: "arc", c: entry.center, r: radius, start: angle(sub(a, entry.center)), sweep };
            const point = (t: number) => t === 0 ? at(a, z) : t === 1 ? at(b, nextZ)
              : at(contourPoint(arc, t), z + (nextZ - z) * t);
            append({ kind: "arc", helical: true, start: point(0), end: point(1), center: at(entry.center, z),
              normal: toolAxis, toolAxis, direction: entry.direction }, Math.hypot(Math.PI * radius, nextZ - z));
            for (let j = 1; j <= count; j++) trace.push(world(point(j / count)));
          }
          entryPaths.push(trace);
          link(at(approach, height), at(start, height), "feed");
        } else {
          link(at(start, clearance), at(start, height), "plunge");
        }
      }
      for (const curve of curves) {
        const point = (t: number) => at(contourPoint(curve, t), height);
        const endpoints = { start: point(0), end: point(1), toolAxis };
        const motion: CamMotion = curve.kind === "line" ? { ...endpoints, kind: "line", mode: "feed" }
          : { ...endpoints, kind: "arc", center: at(curve.c, height), normal: toolAxis, direction: curve.sweep > 0 ? "ccw" : "cw" };
        append(motion, curveLength(curve));
      }
      cuttingPasses.push(sample(cut, height));
      previous = end;
    }
    link(at(previous!, height), at(previous!, clearance), "rapid");
    surface = height;
  }
  if (!Number.isFinite(travel)) return fail("The requested depths or travel are too large.");
  const programmedPaths = boundaries.map((boundary) => sample(boundary, 0));
  return {
    ok: true, value: restoreContourPreview({
      programmed: programmedPaths[0]!, programmedPaths,
      centerline: cuts.length === 1 && centerline === cuts[0] ? cuttingPasses.at(-1)! : sample(centerline, depths.at(-1)!),
      cuttingPasses, entryPaths, linkingMoves, motions, segmentLengths, length: travel, frame: outputFrame, toolFrame: setup,
    }),
  };
}
