import {
  CAM_WORLD, isCamFrame, normalFrame, pocketBoundaries, transformCamVector, type ContourCurve, type CamFrame, type CamProcess, type CamToolPosition, type CamResult, type ContourMillingSettings, type FacingMillingSettings, type PocketMillingSettings,
} from "@whittle/cam";
import { machiningPlane, projectPlanarCurves, resolveOrientation } from "./orientation";
import { modelEdges } from "./modelEdges";
import type { CamCadAdapter } from "./cadAdapter";


export function millingGeometry(cad: CamCadAdapter, documentId: string | undefined, process: CamProcess, setup?: CamFrame) {
  const firstEdge = process.boundaryEdges?.[0];
  const firstEdgeGeometry = firstEdge && cad.resolveEdge?.(firstEdge);
  const face = process.facingFace && cad.resolveFloor?.(process.facingFace);
  const boundary = process.facingFace
    ? setup && face && normalFrame(face.center, face.normal, setup)
    : firstEdge
    ? setup && firstEdgeGeometry && { ...setup, origin: firstEdgeGeometry.mid }
    : process.contour && cad.resolveSketchFrame(process.contour);
  const orientation = setup && isCamFrame(setup) && process.orientation
    ? resolveOrientation(cad, documentId, setup, process.orientation) : undefined;
  const local = orientation?.ok && boundary
    ? machiningPlane(orientation.value, boundary.origin, firstEdge ? undefined : boundary) : undefined;
  const sketch = process.orientation ? local?.ok ? local.value : undefined : boundary;
  const floor = process.floorFace && cad.resolveFloor?.(process.floorFace);
  const floorDepth = floor && sketch && (() => {
    const normal = transformCamVector(floor.normal, CAM_WORLD, sketch, "direction");
    if (Math.abs(normal[2]) < 1 - 1e-8) return;
    const depth = -transformCamVector(floor.center, CAM_WORLD, sketch, "point")[2];
    return depth > 1e-5 ? depth : undefined;
  })();

  return { firstEdge, face, boundary, orientation, local, sketch, floorDepth };
}

export function prepareMilling(
  cad: CamCadAdapter, documentId: string | undefined, process: CamProcess,
  settings: ContourMillingSettings | PocketMillingSettings | FacingMillingSettings,
  tool: CamToolPosition | undefined, setup: CamFrame | undefined, errors: readonly string[],
) {
  const fail = (errors: readonly string[]): CamResult<never> => ({ ok: false, errors });
  const { firstEdge, face, boundary, orientation, local, sketch, floorDepth } = millingGeometry(cad, documentId, process, setup);
  const facing = "strategy" in settings;
  const adaptive = process.kind === "adaptive";
  if (errors.length) return fail(errors);
  if (!process.contour && !firstEdge && !process.facingFace) {
    return fail([facing ? "Pick a planar face, a closed sketch, or closed model boundary edges." : "Pick a sketch or add model boundary edges."]);
  }
  if (!tool) return fail(["Assign a tool position to this operation."]);
  const cutting = cad.resolveToolCutting?.(tool.id);
  if (!cutting?.ok) return fail(cutting?.errors ?? ["The pinned cutting component is unavailable or still updating."]);
  if (cutting.value.family !== "FLAT") return fail([`This operation requires an inherited FLAT cutter TYPE.`]);
  const tip = cad.resolveCoordinateSystem(tool.tipCsysId);
  if (!tip || !isCamFrame(tip)) return fail(["Resolve the assigned tool's master TIP."]);
  const ids = tool.components.map((component) => component.bodyId);
  if (!ids.length || !cad.resolveToolBodies?.(ids)) return fail(["One or more physical tool components are missing or failed to build."]);
  if (orientation && !orientation.ok) return fail(orientation.errors);
  if (local && !local.ok) return fail(local.errors);
  if (process.facingFace && !face) return fail(["The facing face is unavailable. Select it again."]);
  if (!sketch || !setup || !isCamFrame(sketch)) return fail(["Resolve the boundary plane and workpiece coordinate system."]);
  if (process.floorFace && floorDepth === undefined) {
    return fail(["The floor must be available, parallel to the boundary, and below it."]);
  }
  const faceEdges = process.facingFace && cad.resolveFaceBoundary?.(process.facingFace);
  if (process.facingFace && !faceEdges?.length) return fail(["The facing face boundary is unavailable."]);
  const edges = faceEdges || (firstEdge && process.boundaryEdges);
  const contour = edges ? modelEdges(cad, edges, sketch, false) : cad.resolveContour?.(process.contour!);
  if (!contour?.ok) return fail(contour?.errors ?? ["The selected sketch is unavailable."]);
  const curves = !edges && local?.ok && boundary
    ? projectPlanarCurves(contour.value, boundary, sketch) : contour.value;
  if (!facing && "stepover" in settings) {
    const boundary = pocketBoundaries(curves);
    const name = firstEdge ? "Boundary edges" : cad.resolveGeometry(process.contour!)?.name ?? "Pocket boundary sketch";
    if (!boundary.ok) return fail(boundary.errors.map((error) => `${name} · ${error}`));
  }
  const islands: ContourCurve[] = [];
  for (const ref of process.islandSketches ?? []) {
    const name = cad.resolveGeometry(ref)?.name ?? "Island sketch";
    const geometry = cad.resolveContour?.(ref);
    const frame = cad.resolveSketchFrame(ref);
    if (!frame || !isCamFrame(frame) || !geometry?.ok || !geometry.value.length) {
      return fail([`${name} needs available closed sketch geometry.`, ...(geometry && !geometry.ok ? geometry.errors : [])]);
    }
    const island = pocketBoundaries(geometry.value);
    if (!island.ok) return fail(island.errors.map((error) => `${name} · ${error}`));
    const normal = transformCamVector(frame.z, CAM_WORLD, sketch, "direction");
    if (Math.abs(normal[2]) < 1 - 1e-10) return fail([`${name} must be perpendicular to the operation tool axis.`]);
    islands.push(...projectPlanarCurves(island.value.flat(), frame, sketch));
  }
  if (process.islandEdges?.length) {
    const edges = modelEdges(cad, process.islandEdges, sketch, true);
    if (!edges.ok) return fail(edges.errors);
    const loops = pocketBoundaries(edges.value);
    if (!loops.ok) return fail(loops.errors.map((error) => `Island edges · ${error}`));
    islands.push(...loops.value.flat());
  }
  const effective = floorDepth === undefined ? settings : { ...settings, depth: String(floorDepth) };
  const machiningFrame = local?.ok ? local.value : setup;
  return { ok: true, value: {
    kind: "milling", curves, sketch, machiningFrame, settings: effective, diameter: cutting.value.diameter,
    islands, setup, adaptive, tip, ids,
  } } as const;
}
