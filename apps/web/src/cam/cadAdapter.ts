import type { CamFrame, CamGeometryRef, CircularProfileGeometry } from "@whittle/cam";

export interface CamCadAdapter {
  getCoordinateSystems(): readonly { readonly id: string; readonly name: string }[];
  resolveCoordinateSystem(id: string): CamFrame | undefined;
  resolveCircularProfile?(ref: CamGeometryRef): CircularProfileGeometry | undefined;
  getSelection(): readonly CamGeometryRef[];
  /** Returns undefined when the document or entity is unavailable. */
  resolveGeometry(ref: CamGeometryRef): { readonly name: string } | undefined;
}
