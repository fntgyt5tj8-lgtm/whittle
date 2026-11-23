import type { CamVector } from "./geometry/frames";
/** A pinned CAD body. CAM assigns a separate instance ID to each insertion or copy. */
export interface CamCadSource {
  readonly version: 1;
  readonly documentId: string;
  readonly bodyId: string;
  /** SHA-256 of the exact .whittle bytes embedded in the instance. */
  readonly revision: string;
}

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

export interface CamCuttingConditions {
  readonly feed?: string;
  readonly plungeFeed?: string;
  readonly spindleRpm?: string;
}

export interface CircularProfileSettings extends CamCuttingConditions {
  readonly side?: "inside" | "outside";
  readonly direction?: "cw" | "ccw";
  readonly diameter?: string;
  readonly depth?: string;
  readonly clearance?: string;
}

export interface MillingDepthSettings {
  readonly depth: string;
  readonly clearance: string;
  readonly stepdown?: string;
}

export interface FacingMillingSettings extends MillingDepthSettings {
  /** Signed top and final heights relative to the selected boundary plane. */
  readonly top: string;
  readonly stepover: string;
  readonly strategy: "zigzag" | "one-way";
}

export interface PocketMillingSettings extends MillingDepthSettings {
  readonly stepover: string;
  readonly entry?: "plunge" | "helix";
  readonly helixDiameter?: string;
  readonly rampAngle?: string;
  readonly stayDown?: boolean;
}

export interface ContourMillingSettings extends MillingDepthSettings {
  readonly side: "center" | "left" | "right";
  readonly direction: "forward" | "reverse";
  readonly leadIn?: string;
  readonly leadOut?: string;
}

export interface CamGeometryAnchor {
  readonly bounds: readonly [CamVector, CamVector];
  readonly edgeCount: number;
  readonly faceCount: number;
}

export interface CamBoundaryEdge {
  readonly anchor?: CamGeometryAnchor;
  readonly bodyId: string;
  readonly mid: CamVector;
  readonly tangent: CamVector;
  readonly curve: string;
  readonly length: number;
}

export interface CamFloorFace {
  readonly anchor?: CamGeometryAnchor;
  readonly bodyId: string;
  readonly center: CamVector;
  readonly normal: CamVector;
  readonly surface: string;
  readonly area: number;
}

export type CamOrientationSource =
  | { readonly kind: "setup" }
  | { readonly kind: "sketch" }
  | { readonly kind: "face"; readonly documentId: string; readonly face: CamFloorFace }
  | { readonly kind: "plane" | "csys"; readonly documentId: string; readonly entityId: string };

export type CamOrientation = CamOrientationSource & { readonly flip?: boolean };

export interface CamProcess {
  /** Absence preserves the original machining behavior of older projects. */
  readonly orientation?: CamOrientation;
  readonly cuttingConditions?: CamCuttingConditions;
  readonly id: string;
  readonly name: string;
  readonly setupId: string;
  readonly kind: "profile" | "pocket" | "adaptive" | "facing";
  readonly toolPositionId?: string;
  readonly contour?: CamGeometryRef;
  readonly islandSketches?: readonly CamGeometryRef[];
  readonly boundaryEdges?: readonly CamBoundaryEdge[];
  readonly islandEdges?: readonly CamBoundaryEdge[];
  readonly floorFace?: CamFloorFace;
  readonly facingFace?: CamFloorFace;
  readonly contextId?: string;
  readonly profile?: CircularProfileSettings & { readonly csys?: "world" | "sketch" | `datum:${string}` };
  readonly contourMilling?: ContourMillingSettings;
  readonly pocketMilling?: PocketMillingSettings;
  readonly facingMilling?: FacingMillingSettings;
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

export const CAM_TOOL_COMPONENT_ROLES = ["cutter", "insert", "collet", "holder", "adapter", "other"] as const;
export type CamToolComponentRole = typeof CAM_TOOL_COMPONENT_ROLES[number];

/** Rigid conversion of pre-TIP geometry imported from an older CAM document.
 * Origin is in millimetres. Axes describe the old source coordinates in TIP coordinates. */
export interface CamToolSourceTransform {
  readonly origin: readonly [number, number, number];
  readonly xDir: readonly [number, number, number];
  readonly yDir: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
}

export interface CamToolComponent {
  readonly bodyId: string;
  readonly role: CamToolComponentRole;
  readonly sourceToTip?: CamToolSourceTransform;
}

export interface CamToolPosition {
  readonly id: string;
  readonly number: number;
  readonly name: string;
  readonly components: readonly CamToolComponent[];
  readonly tipCsysId: string;
  /** Required to disambiguate multiple cutter or insert components. */
  readonly cuttingBodyId?: string;
  /** Legacy file input only. Converted to native TIP and component transforms on load. */
  readonly placement?: {
    readonly position: readonly [string, string, string];
    readonly rotation: readonly [string, string, string];
  };
  /** Archived compensation from older files. Inherited dimensions drive current operations. */
  readonly profileDiameter?: number;
  readonly cutting?: FlatEndmill;
}

export interface CamProject {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly setups: readonly CamSetup[];
  readonly processes: readonly CamProcess[];
  /** Part history in planning order. Execution dependencies are independent of this order. */
  readonly processPlan?: readonly CamPlanItem[];
  readonly toolPositions?: readonly CamToolPosition[];
  /** Reserved metadata from earlier CAM documents. */
  readonly tooling?: Readonly<Record<string, unknown>>;
}

export interface FlatEndmill {
  readonly kind: "flat-endmill";
  readonly diameter: number;
}

export type CamResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };
