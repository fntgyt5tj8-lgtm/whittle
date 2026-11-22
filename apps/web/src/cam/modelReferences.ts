import type { CamBoundaryEdge, CamFloorFace, CamGeometryAnchor, CamVector } from "@whittle/cam";
import type { BodyResult } from "@whittle/kernel";

type ModelGeometry = Pick<BodyResult, "bbox" | "edges" | "faces">;

const EPS = 1e-5;
const dot = (a: CamVector, b: CamVector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function modelAnchor(body: ModelGeometry): CamGeometryAnchor {
  return { bounds: body.bbox, edgeCount: body.edges.length, faceCount: body.faces.length };
}

function match<T>(
  items: readonly T[], point: (item: T) => CamVector, size: (item: T) => number,
  savedPoint: CamVector, savedSize: number, body: ModelGeometry, anchor?: CamGeometryAnchor,
): T | undefined {
  if (anchor && (anchor.edgeCount !== body.edges.length || anchor.faceCount !== body.faces.length)) return;
  const [lo, hi] = body.bbox;
  const expected = savedPoint.map((coord, i) => {
    if (!anchor) return coord;
    const oldLo = anchor.bounds[0][i]!, oldSpan = anchor.bounds[1][i]! - oldLo;
    if (oldSpan <= EPS) return coord + lo[i]! - oldLo;
    return lo[i]! + (coord - oldLo) * (hi[i]! - lo[i]!) / oldSpan;
  });
  const unchangedBounds = !anchor || anchor.bounds.every((corner, i) =>
    corner.every((coord, axis) => Math.abs(coord - body.bbox[i]![axis]!) <= EPS));
  if (unchangedBounds) {
    const exact = items.filter((item) => Math.abs(size(item) - savedSize) <= EPS
      && point(item).every((coord, i) => Math.abs(coord - savedPoint[i]!) <= EPS));
    if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  }

  const ranked = items.flatMap((item) => {
    const ratio = size(item) / savedSize;
    if (!(ratio >= 0.25 && ratio <= 4)) return [];
    const score = Math.hypot(...point(item).map((coord, i) =>
      (coord - expected[i]!) / Math.max(hi[i]! - lo[i]!, EPS)));
    return [{ item, score }];
  }).sort((a, b) => a.score - b.score);
  const [best, second] = ranked;
  if (!best || best.score > (anchor ? 0.18 : 0.12)) return;
  // Leave references unresolved when two candidates are both plausible.
  if (second && second.score <= best.score * 1.75 + 0.005) return;
  return best.item;
}

export function resolveModelEdge(body: ModelGeometry, ref: CamBoundaryEdge) {
  const candidates = body.edges.filter((edge) => edge.curve === ref.curve
    && Math.abs(dot(edge.tangent, ref.tangent)) >= (edge.curve === "LINE" ? 0.999 : 0.98));
  return match(candidates, (edge) => edge.mid, (edge) => edge.length, ref.mid, ref.length, body, ref.anchor);
}

export function resolveModelFloor(body: ModelGeometry, ref: CamFloorFace) {
  const candidates = body.faces.filter((face) => face.surface === "PLANE" && dot(face.normal, ref.normal) > 0.999);
  return match(candidates, (face) => face.center, (face) => Math.sqrt(face.area),
    ref.center, Math.sqrt(ref.area), body, ref.anchor);
}
