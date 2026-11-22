import type { CamFrame } from "./frames";

export interface CircularProfileGeometry {
  readonly center: readonly [number, number];
  readonly radius: number;
  /** Sketch XY plane in the reference space shared with the workpiece CSYS. */
  readonly operationFrame: CamFrame;
}
