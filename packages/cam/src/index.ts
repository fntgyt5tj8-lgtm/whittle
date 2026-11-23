export { CAM_TOOL_COMPONENT_ROLES } from "./model";
export { canCut, cuttingComponent, cuttingToolType, CUTTING_TOOL_TYPES } from "./toolGeometry";
export type { CamCuttingGeometry, CuttingToolType } from "./toolGeometry";
export type { CamToolComponent, CamToolComponentRole, CamToolPosition, CamToolSourceTransform } from "./model";
export type { CamCuttingConditions, CamBodyRole, CamCadSource, CamContextFrame, CamGeometryRef, CamWorkpieceContext, CamMachiningStage, CamPlanItem, CamPlanStage, CamProcess, CamProject, CamResult, CamSetup, CircularProfileSettings, FlatEndmill } from "./model";
export {
  activePlanEnd, addPlanStage, addProcess, addSetup, createProject, deletePlannedOperation, getProcessPlan,
  migrateWorkpieceContexts, movePlannedOperation, plannedOperations, planMoveProblem, rollBackPlan,
} from "./operations";
export { validateOperationTooling, validateProject } from "./validation";
export { CAM_WORLD, isCamFrame, transformCamVector } from "./geometry/frames";
export { normalFrame, flipCamFrame, camPlaneAt } from "./geometry/frames";
export type { CamFrame, CamVector } from "./geometry/frames";
export type { CircularProfileGeometry } from "./geometry/circle";
export { generateCircularProfile, validateCircularProfile } from "./algorithms/circularProfile";
export type { CircularProfile, CircularProfileAlgorithm } from "./algorithms/circularProfile";
export type { CamMotion, CamToolpath } from "./toolpath/model";
export { validateToolpath } from "./toolpath/validation";
export type { AptOperation } from "./export/apt";
export { exportAptCl, exportAptProgram } from "./export/apt";
export type { ContourMillingSettings } from "./model";
export { contourTravel, generateContour } from "./algorithms/contour";
export type { ContourCurve, ContourPoint, ContourPreview } from "./algorithms/contour";
export type { FacingMillingSettings, PocketMillingSettings } from "./model";
export { generateFacing } from "./algorithms/facing";
export { generatePocket } from "./algorithms/pocket";
export { generateAdaptive } from "./algorithms/adaptive";
export { pocketBoundaries } from "./algorithms/pocketRegions";
export type { CamBoundaryEdge, CamFloorFace, CamGeometryAnchor, CamOrientation, CamOrientationSource } from "./model";
