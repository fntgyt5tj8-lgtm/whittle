import type { CamProject, CamToolComponentRole, CamToolPosition } from "./model";

export const CUTTING_TOOL_TYPES = ["FLAT", "BALL", "TOROIDAL", "LOLLIPOP", "CONICAL", "FORM"] as const;
export type CuttingToolType = typeof CUTTING_TOOL_TYPES[number];

export function cuttingToolType(value: number): CuttingToolType | undefined {
  return Number.isInteger(value) && value >= 0 && value < CUTTING_TOOL_TYPES.length
    ? CUTTING_TOOL_TYPES[value] : undefined;
}

/** Dimensions are expressed in millimetres, independently of the physical assembly. */
export interface CamCuttingGeometry {
  readonly type: number;
  readonly family: CuttingToolType;
  readonly diameter: number;
  readonly cutterLength?: number;
  readonly fluteLength?: number;
  readonly shankDiameter?: number;
}

export const canCut = (role: CamToolComponentRole) => role === "cutter" || role === "insert";

export function cuttingComponent(tool: CamToolPosition) {
  const candidates = tool.components.filter(({ role }) => canCut(role));
  return tool.cuttingBodyId === undefined
    ? (candidates.length === 1 ? candidates[0] : undefined)
    : candidates.find(({ bodyId }) => bodyId === tool.cuttingBodyId);
}

/** Preserve older compensation values and discard obsolete component geometry metadata. */
export function migrateToolGeometry(project: CamProject): CamProject {
  if (!project.toolPositions?.some((tool) => tool.cutting !== undefined
    || tool.components.some((component) => "geometry" in component))) return project;
  return {
    ...project,
    toolPositions: project.toolPositions.map(({ cutting, ...tool }) => ({
      ...tool,
      profileDiameter: tool.profileDiameter ?? cutting?.diameter,
      components: tool.components.map(({ geometry: _obsolete, ...component }: typeof tool.components[number] & { geometry?: unknown }) => component),
    })),
  };
}
