/** A document-scoped reference whose identity is assigned by the CAD host. */
export interface CamGeometryRef {
  readonly documentId: string;
  readonly kind: "body" | "sketch";
  readonly entityId: string;
}

export interface CamSetup {
  readonly id: string;
  readonly name: string;
  readonly part: CamGeometryRef;
}

export interface CamProcess {
  readonly id: string;
  readonly name: string;
  readonly setupId: string;
  readonly kind: "profile";
  readonly contour?: CamGeometryRef;
  readonly track?: { readonly unitId: string; readonly id: string };
}

export type CamMachiningStage = "main" | "sub";

export type CamPlanStage = {
  readonly kind: "transfer" | "ejection";
  readonly id: string;
  readonly setupId: string;
};

export type CamPlanItem =
  | { readonly kind: "process"; readonly processId: string; readonly stage: CamMachiningStage }
  | CamPlanStage;

export interface CamProject {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly setups: readonly CamSetup[];
  readonly processes: readonly CamProcess[];
  /** Part history in planning order. Execution dependencies are independent of this order. */
  readonly processPlan?: readonly CamPlanItem[];
}

export interface FlatEndmill {
  readonly kind: "flat-endmill";
  readonly diameter: number;
}

export type CamResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };
