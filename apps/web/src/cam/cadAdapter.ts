import type { CamBoundaryEdge, CamFloorFace, CamVector, CamCuttingGeometry, CamResult, CamFrame, CamGeometryRef, CircularProfileGeometry, ContourCurve } from "@whittle/cam";

export interface CamCadAdapter {
  getCoordinateSystems(): readonly { readonly id: string; readonly name: string }[];
  resolveToolCutting?(id: string): CamResult<CamCuttingGeometry> | undefined;
  resolveCoordinateSystem(id: string): CamFrame | undefined;
  resolveSketchFrame(ref: CamGeometryRef): CamFrame | undefined;
  resolveCircularProfile?(ref: CamGeometryRef): CircularProfileGeometry | undefined;
  resolveContour?(ref: CamGeometryRef): CamResult<readonly ContourCurve[]>;
  selectedEdges?(): readonly CamBoundaryEdge[];
  selectedFloor?(): CamFloorFace | undefined;
  resolveFloor?(ref: CamFloorFace): CamFloorFace | undefined;
  resolveEdge?(ref: CamBoundaryEdge): {
    curve: string; ends: readonly [CamVector, CamVector]; mid: CamVector; tangent: CamVector;
    endTangents?: readonly [CamVector, CamVector];
  } | undefined;
  resolveToolBodies?(ids: readonly string[]): boolean;
  getSelection(): readonly CamGeometryRef[];
  /** Returns undefined when the document or entity is unavailable. */
  resolveGeometry(ref: CamGeometryRef): { readonly name: string } | undefined;
}
