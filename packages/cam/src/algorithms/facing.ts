import type { CamFrame } from "../geometry/frames";
import type { CamResult, FacingMillingSettings } from "../model";
import { buildPlanarPreview, contourPoint, orderContour, planMillingDepths,
  type ContourCurve, type ContourPoint, type ContourPreview } from "./contour";

const TOLERANCE = 1e-5;
const TAU = 2 * Math.PI;
const fail = (message: string): CamResult<never> => ({ ok: false, errors: [message] });

function extrema(curve: ContourCurve): ContourPoint[] {
  const points = [contourPoint(curve, 0), contourPoint(curve, 1)];
  if (curve.kind === "arc") {
    for (const angle of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
      const delta = (angle - curve.start) * Math.sign(curve.sweep);
      const distance = ((delta % TAU) + TAU) % TAU;
      if (distance <= Math.abs(curve.sweep)) points.push(contourPoint(curve, distance / Math.abs(curve.sweep)));
    }
  }
  return points;
}

export function generateFacing(
  input: readonly ContourCurve[], boundary: CamFrame, machining: CamFrame,
  settings: FacingMillingSettings, diameter: number, outputFrame = machining,
): CamResult<ContourPreview> {
  const top = Number(settings.top), final = Number(settings.depth), clearance = Number(settings.clearance);
  if (!settings.depth.trim() || ![top, final, clearance].every(Number.isFinite) || final >= top || clearance <= 0) {
    return fail("Enter a final depth below the top height and positive clearance.");
  }
  const safeHeight = Math.max(0, top) + clearance;
  const depths = planMillingDepths(boundary, machining, { ...settings, depth: String(top - final) }, diameter);
  if (!depths.ok) return depths;
  const stepover = Number(settings.stepover);
  if (!(stepover > 0 && stepover <= 100)) return fail("Enter facing stepover above 0 and at most 100%.");
  if (settings.strategy !== "zigzag" && settings.strategy !== "one-way") return fail("Choose a facing raster strategy.");
  if (diameter / 2 <= TOLERANCE || !Number.isFinite(safeHeight) || safeHeight <= Math.max(0, top)) return fail("The cutter or clearance is too small for facing.");

  const chain = orderContour(input);
  if (!chain.ok) return chain;
  if (!chain.value.closed) return fail("Facing requires a single closed boundary.");
  const curves = chain.value.curves;
  const points = curves.flatMap(extrema);
  const minX = Math.min(...points.map(([x]) => x)), maxX = Math.max(...points.map(([x]) => x));
  const minY = Math.min(...points.map(([, y]) => y)), maxY = Math.max(...points.map(([, y]) => y));
  const width = maxX - minX, height = maxY - minY;
  if (width <= TOLERANCE || height <= TOLERANCE) return fail("The facing boundary is too small.");

  // Each row spans the full X envelope. Side turns and plunges are outside
  // that envelope by more than a radius, even for concave boundaries.
  const overrun = diameter / 2 + TOLERANCE;
  const left = minX - overrun, right = maxX + overrun;
  const intervals = Math.ceil(height / (diameter * (stepover / 100)));
  if (!(intervals >= 1 && intervals < 500) || !Number.isFinite(left + right)
    || minX - left <= diameter / 2 || right - maxX <= diameter / 2) {
    return fail("Facing exceeds the supported range or requires more than 500 raster rows.");
  }
  if ((intervals + 1) * depths.value.length > 20_000) return fail("Facing supports up to 20,000 rows across all depth passes.");

  const rows: ContourCurve[][] = [];
  const raster: ContourCurve[] = [];
  for (let row = 0; row <= intervals; row++) {
    const y = row === intervals ? maxY : minY + height * (row / intervals);
    const reverse = settings.strategy === "zigzag" && row % 2 !== 0;
    const a: ContourPoint = [reverse ? right : left, y], b: ContourPoint = [reverse ? left : right, y];
    const preceding = raster.at(-1);
    if (preceding && settings.strategy === "zigzag") raster.push({ kind: "line", a: contourPoint(preceding, 1), b: a });
    const pass = { kind: "line", a, b } as const;
    raster.push(pass);
    rows.push([pass]);
  }
  const heights = depths.value.map((depth, i) => i === depths.value.length - 1 ? final : top + depth);
  if (heights.some((height, i) => !(height < (heights[i - 1] ?? top)))) return fail("Facing depth increments are too small.");
  const cuts = settings.strategy === "zigzag" ? [raster] : rows;
  return buildPlanarPreview([curves], cuts[0]!, cuts, boundary, machining, heights, safeHeight, undefined, undefined, outputFrame);
}
