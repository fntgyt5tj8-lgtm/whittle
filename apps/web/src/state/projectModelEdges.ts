import { addArcFromCenter, addCircle, addConstraint, addLine, addProjectedPolyline,
  type SketchFeature, type Vec2, type Vec3 } from "@whittle/core";
import type { BodyResult, SketchFrame } from "@whittle/kernel";

const TAU = 2 * Math.PI;
const ccw = (angle: number) => ((angle % TAU) + TAU) % TAU;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function projectModelEdges(sketch: SketchFeature, body: Pick<BodyResult, "edges" | "edgeRanges" | "edgePositions">,
  edges: readonly number[], frame: Pick<SketchFrame, "origin" | "xDir" | "yDir">) {
  const local = (p: Vec3): Vec2 => {
    const delta: Vec3 = [p[0] - frame.origin[0], p[1] - frame.origin[1], p[2] - frame.origin[2]];
    return [dot(delta, frame.xDir), dot(delta, frame.yDir)];
  };
  const shared = (p: Vec2) => (sketch.geometry ?? []).find((g) => g.type === "point" && !g.construction
    && Math.hypot(g.x - p[0], g.y - p[1]) <= 1e-9)?.id ?? p;
  let made = 0;
  for (const index of edges) {
    const edge = body.edges[index];
    if (!edge) continue;
    if (edge.ends && (edge.curve === "LINE" || (edge.circle
      && Math.hypot(dot(edge.circle.normal, frame.xDir), dot(edge.circle.normal, frame.yDir)) <= 1e-12))) {
      const a = local(edge.ends[0]), b = local(edge.ends[1]);
      const chord = Math.hypot(a[0] - b[0], a[1] - b[1]);
      let id: string;
      if (edge.curve === "LINE") {
        if (chord < 1e-6) continue;
        id = addLine(sketch, shared(a), shared(b));
      } else {
        const circle = edge.circle!;
        const c = local(circle.center);
        if (chord <= 1e-9 && Math.abs(edge.length - TAU * circle.radius) <= 1e-9 * Math.max(1, circle.radius)) {
          id = addCircle(sketch, c, circle.radius);
        } else {
          const angle = (p: Vec2) => Math.atan2(p[1] - c[1], p[0] - c[0]);
          const start = angle(a);
          const forward = ccw(angle(local(edge.mid)) - start) < ccw(angle(b) - start);
          id = addArcFromCenter(sketch, shared(forward ? a : b), shared(forward ? b : a), c);
        }
      }
      addConstraint(sketch, "fixed", [id]);
      made++;
      continue;
    }
    // Oblique circles and other curves still use the existing sampled projection.
    const first = body.edgeRanges[index * 2]!;
    const count = body.edgeRanges[index * 2 + 1]!;
    const positions = body.edgePositions;
    const point = (vertex: number) => local([positions[3 * vertex]!, positions[3 * vertex + 1]!, positions[3 * vertex + 2]!]);
    const points: Vec2[] = [];
    for (let k = 0; k + 1 < count; k += 2) {
      if (!points.length) points.push(point(first + k));
      points.push(point(first + k + 1));
    }
    if (addProjectedPolyline(sketch, points)) made++;
  }
  return made;
}
