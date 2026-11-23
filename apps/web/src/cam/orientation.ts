import {
  CAM_WORLD, camPlaneAt, flipCamFrame, isCamFrame, normalFrame, transformCamVector,
  type CamFrame, type CamOrientation, type CamResult, type CamVector, type ContourCurve,
} from "@whittle/cam";
import type { CamCadAdapter } from "./cadAdapter";

export function resolveOrientation(
  cad: CamCadAdapter, documentId: string | undefined, setup: CamFrame, orientation?: CamOrientation, sketch?: CamFrame,
): CamResult<CamFrame> {
  const missing = { ok: false, errors: ["The operation orientation source is unavailable. Select it again or use setup Z."] } as const;
  if (!orientation || orientation.kind === "setup") {
    return { ok: true, value: orientation?.flip ? flipCamFrame(setup) : setup };
  }
  if (orientation.kind === "sketch") {
    return sketch && isCamFrame(sketch) ? { ok: true, value: orientation.flip ? flipCamFrame(sketch) : sketch } : missing;
  }
  if (orientation.documentId !== documentId) return missing;

  let frame: CamFrame | undefined;
  if (orientation.kind === "face") {
    const face = cad.resolveFloor?.(orientation.face);
    if (face?.surface === "PLANE") frame = normalFrame(face.center, face.normal, setup);
  } else if (orientation.kind === "plane") {
    const plane = cad.resolveDatumPlane?.(orientation.entityId);
    if (plane) frame = normalFrame(plane.origin, plane.z, setup);
  } else if (cad.getCoordinateSystems().some(({ id }) => id === orientation.entityId)) {
    frame = cad.resolveCoordinateSystem(orientation.entityId);
  }
  if (!frame || !isCamFrame(frame)) return missing;
  return { ok: true, value: orientation.flip ? flipCamFrame(frame) : frame };
}

export function machiningPlane(
  orientation: CamFrame, boundaryPoint: CamVector, sketch?: CamFrame,
): CamResult<CamFrame> {
  if (sketch && (!isCamFrame(sketch) || Math.abs(transformCamVector(sketch.z, CAM_WORLD, orientation, "direction")[2]) < 1 - 1e-10)) {
    return { ok: false, errors: ["The boundary sketch must be perpendicular to the operation tool axis."] };
  }
  return { ok: true, value: camPlaneAt(orientation, boundaryPoint) };
}

export function projectPlanarCurves(curves: readonly ContourCurve[], from: CamFrame, to: CamFrame): ContourCurve[] {
  const sense = Math.sign(transformCamVector(from.z, CAM_WORLD, to, "direction")[2]);
  const point = ([x, y]: readonly [number, number]) => {
    const [u, v] = transformCamVector([x, y, 0], from, to, "point");
    return [u, v] as const;
  };
  return curves.map((curve) => {
    if (curve.kind === "line") return { ...curve, a: point(curve.a), b: point(curve.b) };
    const [u, v] = transformCamVector([Math.cos(curve.start), Math.sin(curve.start), 0], from, to, "direction");
    return { ...curve, c: point(curve.c), start: Math.atan2(v, u), sweep: curve.sweep * sense };
  });
}
