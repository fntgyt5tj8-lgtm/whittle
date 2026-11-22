/** A document-scoped reference whose identity is assigned by the CAD host. */
export interface CamGeometryRef {
  readonly documentId: string;
  readonly kind: "body" | "sketch";
  readonly entityId: string;
}

export type CamBodyRole = "workpiece" | "stock" | "fixture";

export interface CamBodyAssignment {
  readonly body: CamGeometryRef & { readonly kind: "body" };
  readonly role: CamBodyRole;
}

export type CamContextFrame =
  | { readonly kind: "native"; readonly csysId: string }
  // Phase 01 files could use implicit frames with no native CAD feature.
  | { readonly kind: "legacy-world" }
  | { readonly kind: "legacy-sketch"; readonly sketch?: CamGeometryRef };

export interface CamWorkpieceContext {
  readonly id: string;
  readonly name: string;
  readonly frame: CamContextFrame;
  readonly bodies: readonly CamBodyAssignment[];
}

export interface CamSetup {
  readonly id: string;
  readonly name: string;
  /** Phase 01 part reference, retained for sketch selection and compatibility. */
  readonly part?: CamGeometryRef;
  readonly contexts?: readonly CamWorkpieceContext[];
}

export interface CircularProfileSettings {
  readonly side?: "inside" | "outside";
  readonly direction?: "cw" | "ccw";
  readonly diameter?: string;
  readonly depth?: string;
  readonly clearance?: string;
  readonly feed?: string;
  readonly plungeFeed?: string;
}

export interface CamProcess {
  readonly id: string;
  readonly name: string;
  readonly setupId: string;
  readonly kind: "profile";
  readonly contour?: CamGeometryRef;
  readonly contextId?: string;
  readonly profile?: CircularProfileSettings & { readonly csys?: "world" | "sketch" | `datum:${string}` };
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
