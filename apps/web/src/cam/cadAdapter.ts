import type { CamGeometryRef, CircularProfileGeometry } from "@whittle/cam";

export interface CamCadAdapter {
  resolveCircularProfile?(ref: CamGeometryRef): CircularProfileGeometry | undefined;
  getSelection(): readonly CamGeometryRef[];
  /** Returns undefined when the document or entity is unavailable. */
  resolveGeometry(ref: CamGeometryRef): { readonly name: string } | undefined;
}
