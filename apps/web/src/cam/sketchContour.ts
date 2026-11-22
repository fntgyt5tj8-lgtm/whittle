import {
  chainSegments, circleThrough, documentEvaluator, entityOutline, resolveEntity, resolveGeometry,
  type SketchFeature, type SketchSolution, type WhittleDocument,
} from "@whittle/core";
import type { CamResult, ContourCurve, ContourPoint } from "@whittle/cam";

const TAU = 2 * Math.PI;
const ccw = (a: number) => ((a % TAU) + TAU) % TAU;
const angle = (center: ContourPoint, p: ContourPoint) => Math.atan2(p[1] - center[1], p[0] - center[0]);

export function sketchContour(doc: WhittleDocument, sketch: SketchFeature, solution?: SketchSolution): CamResult<ContourCurve[]> {
  const curves: ContourCurve[] = [];
  try {
    const evaluator = documentEvaluator(doc);
    for (const entity of sketch.entities.filter((item) => !item.construction)) {
      const shape = resolveEntity(entity, evaluator);
      if (shape.type === "circle") {
        curves.push({ kind: "arc", c: [shape.cx, shape.cy], r: shape.r, start: 0, sweep: TAU });
      } else if (shape.type === "polyline" && !shape.corner && !shape.smooth && !shape.ctrl && !shape.splines.some(Boolean)) {
        for (const part of chainSegments(shape.points, shape.arcs, !shape.open)) {
          if (part.kind === "line") curves.push(part);
          else if (part.kind === "arc") {
            const c = circleThrough(part.a, part.mid, part.b);
            if (!c) throw new Error("A three-point arc is degenerate.");
            const start = angle(c, part.a);
            const end = ccw(angle(c, part.b) - start);
            const sweep = ccw(angle(c, part.mid) - start) < end ? end : end - TAU;
            curves.push({ kind: "arc", c, r: Math.hypot(part.a[0] - c[0], part.a[1] - c[1]), start, sweep });
          }
        }
      } else if ((shape.type === "rect" && !shape.corner) || shape.type === "polygon") {
        const points = entityOutline(shape);
        curves.push(...points.map((a, i) => ({ kind: "line" as const, a, b: points[(i + 1) % points.length]! })));
      } else {
        throw new Error(`Unsupported sketch entity: ${shape.type}. Use lines, circles or circular arcs.`);
      }
    }
    const native = (sketch.geometry ?? []).filter((item) => item.type !== "point" && !item.construction);
    if (native.length && solution?.state !== "full" && solution?.state !== "under") {
      throw new Error("Solve the sketch constraints before generating a contour.");
    }
    if (native.length) {
      const byId = new Map(resolveGeometry(sketch, solution).map((item) => [item.id, item]));
      for (const { id } of native) {
        const item = byId.get(id)!;
        if (item.type === "line") curves.push({ kind: "line", a: item.a, b: item.b });
        else if (item.type === "circle") curves.push({ kind: "arc", c: item.c, r: item.r, start: 0, sweep: TAU });
        else if (item.type === "arc") {
          if (Math.abs(Math.hypot(item.b[0] - item.c[0], item.b[1] - item.c[1]) - item.r) > 1e-5) {
            throw new Error("A solved arc has mismatched endpoint radii.");
          }
          curves.push({ kind: "arc", c: item.c, r: item.r, start: item.a0, sweep: item.sweep });
        } else throw new Error(`Unsupported sketch geometry: ${item.type}. Use lines, circles or circular arcs.`);
      }
    }
    return { ok: true, value: curves };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : "The sketch could not be resolved."] };
  }
}
