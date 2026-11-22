import type { CamVector } from "../geometry/frames";
import type { FlatEndmill } from "../model";

interface MotionEndpoints {
  readonly start: CamVector;
  readonly end: CamVector;
  /** IJK is the fixed tool axis, pointing away from the work. */
  readonly toolAxis: CamVector;
}

export type CamMotion = MotionEndpoints & (
  | { readonly kind: "line"; readonly mode: "feed" | "plunge" | "rapid" }
  | {
    readonly kind: "arc";
    readonly center: CamVector;
    readonly normal: CamVector;
    /** For a helix the center lies in the start plane and the endpoint carries axial travel. */
    readonly helical?: true;
    /** Viewed from the positive end of the normal. */
    readonly direction: "cw" | "ccw";
  }
);

/** Motion coordinates are expressed in the workpiece CSYS. */
export interface CamToolpath {
  readonly tool: FlatEndmill;
  readonly feed: number;
  readonly plungeFeed: number;
  readonly motions: readonly CamMotion[];
}
