import { CAM_WORLD, transformCamVector, type CamBoundaryEdge, type CamFrame,
  type CamResult, type ContourCurve, type ContourPoint } from "@whittle/cam";
import { circleThrough } from "@whittle/core";
import type { CamCadAdapter } from "./cadAdapter";

const TAU = 2 * Math.PI;
const TOLERANCE = 1e-5;
const ccw = (angle: number) => ((angle % TAU) + TAU) % TAU;
const fail = (message: string): CamResult<never> => ({ ok: false, errors: [message] });

export function modelEdges(cad: CamCadAdapter, refs: readonly CamBoundaryEdge[], frame: CamFrame, project: boolean):
  CamResult<ContourCurve[]> {
  const curves: ContourCurve[] = [];
  for (const ref of refs) {
    const edge = cad.resolveEdge?.(ref);
    if (!edge) return fail("A selected edge is unavailable or has changed. Remove it and select it again.");
    const [a, mid, b] = [edge.ends[0], edge.mid, edge.ends[1]].map((p) => transformCamVector(p, CAM_WORLD, frame, "point"));
    const tangents = [edge.tangent, ...(edge.endTangents ?? [])].map((p) => transformCamVector(p, CAM_WORLD, frame, "direction"));
    if (Math.abs(a![2] - mid![2]) > TOLERANCE || Math.abs(b![2] - mid![2]) > TOLERANCE
      || (!project && Math.abs(mid![2]) > TOLERANCE) || tangents.some((t) => Math.abs(t[2]) > TOLERANCE)) {
      return fail(project ? "Island edges must lie in planes perpendicular to the operation tool axis." : "Boundary edges must lie in the machining plane.");
    }
    const start: ContourPoint = [a![0], a![1]], end: ContourPoint = [b![0], b![1]], middle: [number, number] = [mid![0], mid![1]];
    if (edge.curve === "LINE") {
      curves.push({ kind: "line", a: start, b: end });
    } else if (edge.curve === "CIRCLE") {
      if (Math.hypot(start[0] - end[0], start[1] - end[1]) <= TOLERANCE) {
        const center: ContourPoint = [(start[0] + middle[0]) / 2, (start[1] + middle[1]) / 2];
        curves.push({ kind: "arc", c: center, r: Math.hypot(start[0] - center[0], start[1] - center[1]), start: 0, sweep: TAU });
      } else {
        const center = circleThrough([...start], middle, [...end]);
        if (!center) return fail("A selected circular edge is degenerate.");
        const angle = (p: ContourPoint) => Math.atan2(p[1] - center[1], p[0] - center[0]);
        const begin = angle(start);
        const span = ccw(angle(end) - begin);
        const sweep = ccw(angle(middle) - begin) < span ? span : span - TAU;
        curves.push({ kind: "arc", c: center, r: Math.hypot(start[0] - center[0], start[1] - center[1]), start: begin, sweep });
      }
    } else return fail("Select straight or circular model edges.");
  }
  return { ok: true, value: curves };
}
