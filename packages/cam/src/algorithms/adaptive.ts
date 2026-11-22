import type { CamFrame } from "../geometry/frames";
import type { CamResult, PocketMillingSettings } from "../model";
import { buildPlanarPreview, contourPoint, planMillingDepths, type ContourCurve, type ContourPoint, type ContourPreview, type HelixEntry } from "./contour";
import { circularClearing } from "./pocket";
import { offsetPocket, pocketBoundaries, POCKET_OFFSET_EDGE_LIMIT, POCKET_OFFSET_LEVEL_LIMIT } from "./pocketRegions";
import { planAdaptiveRegions } from "./adaptiveRegions";
import { prepareHelicalEntry } from "./helixEntry";
import { createAdaptiveLinkPlanner } from "./adaptiveLinks";

const TAU = 2 * Math.PI;
const MIN_MOVE = 1e-5;
const MAX_RINGS = 500;
const fail = (message: string): CamResult<never> => ({ ok: false, errors: [message] });

/** Area on one side of a chord whose signed distance is measured from the disk center. */
function cap(radius: number, distance: number) {
  const ratio = Math.max(-1, Math.min(1, distance / radius));
  return radius ** 2 * (Math.acos(ratio) - ratio * Math.sqrt(1 - ratio ** 2));
}

/** Unit cutter disk area outside the disk already cleared at this depth. */
function exposedArea(center: number, cleared: number) {
  if (center <= cleared - 1) return 0;
  if (center >= cleared + 1) return Math.PI;
  const chord = ((center - cleared) * (center + cleared) + 1) / (2 * center);
  return Math.max(0, cap(1, -chord) - cap(cleared, center - chord));
}

export function generateAdaptive(
  input: readonly ContourCurve[], sketch: CamFrame, setup: CamFrame, settings: PocketMillingSettings, diameter: number,
  islandCurves: readonly ContourCurve[] = [],
): CamResult<ContourPreview> {
  const depths = planMillingDepths(sketch, setup, settings, diameter);
  if (!depths.ok) return depths;
  const clearance = Number(settings.clearance);
  function preview(boundaries: readonly (readonly ContourCurve[])[], wall: readonly ContourCurve[],
    cuts: readonly (readonly ContourCurve[])[], heights: readonly number[]) {
    const fit = settings.entry === "helix" ? prepareHelicalEntry(boundaries, settings, diameter) : undefined;
    if (fit && !fit.ok) return fit;
    const stock = settings.stayDown
      ? createAdaptiveLinkPlanner(contourPoint(cuts[0]![0]!, 0), diameter / 2, boundaries.flat(), target) : undefined;
    if (!fit && !stock) return buildPlanarPreview(boundaries, wall, cuts, sketch, setup, heights, clearance);
    const planned: (readonly ContourCurve[])[] = [];
    const entries: (HelixEntry | undefined)[] = [];
    const stayDown: (readonly ContourPoint[] | undefined)[] = [];
    let routedLinks = 0;
    let cutLinks = 0;
    for (const [i, cut] of cuts.entries()) {
      const linked = stock?.choose(cut);
      let next = linked?.cut ?? cut;
      if (linked?.kind === "cut") cutLinks++;
      if (fit?.ok && !linked) {
        const result = fit.value(cut, i);
        if (!result.ok) return result;
        next = result.value.cut;
        entries[i] = result.value.entry;
      }
      planned.push(next);
      stayDown.push(linked ? linked.waypoints ?? [] : undefined);
      if (linked?.waypoints?.length) routedLinks++;
      stock?.record(next);
    }
    const result = buildPlanarPreview(boundaries, wall, planned, sketch, setup, heights, clearance, entries, stayDown);
    return result.ok && stock ? { ok: true as const, value: {
      ...result.value, stayDownLinkCount: stayDown.filter(Boolean).length * heights.length,
      stayDownCutLinkCount: cutLinks * heights.length,
      routedStayDownLinkCount: routedLinks * heights.length,
    } } : result;
  }
  const engagement = Number(settings.stepover);
  if (!Number.isFinite(engagement) || engagement < 1 || engagement > 50) {
    return fail("Enter a target radial engagement from 1% to 50% of the cutter diameter.");
  }

  const radius = diameter / 2;
  const targetWidth = diameter * engagement / 100;
  const target = cap(1, 1 - targetWidth / radius);
  const circle = input[0];
  if (islandCurves.length || input.length !== 1 || circle?.kind !== "arc" || !Number.isFinite(circle.sweep)
    || Math.abs(Math.abs(circle.sweep) - TAU) > 1e-12) {
    const boundaries = pocketBoundaries(input);
    if (!boundaries.ok) return boundaries;
    const islands = islandCurves.length ? pocketBoundaries(islandCurves) : undefined;
    if (islands && !islands.ok) return islands;
    const islandLoops = islands?.value ?? [];
    const loops = [...boundaries.value, ...islandLoops];
    let offsets = offsetPocket(loops, radius, targetWidth / 5, 0.001, islandLoops.length);
    // Coarsen the candidate grid only on complexity limits. Engagement and
    // cutter-envelope checks still govern the resulting paths.
    for (const divisor of [3, 2, 1]) {
      if (offsets.ok || !offsets.errors.some((error) => error === POCKET_OFFSET_EDGE_LIMIT || error === POCKET_OFFSET_LEVEL_LIMIT)) break;
      offsets = offsetPocket(loops, radius, targetWidth / divisor, 0.001, islandLoops.length);
    }
    if (!offsets.ok) return offsets;
    const plan = planAdaptiveRegions(offsets.value.levels, radius, targetWidth, target);
    if (!plan.ok) return plan;
    const result = preview(loops, offsets.value.wall, plan.value.cuts, depths.value);
    return result.ok
      ? { ok: true, value: { ...result.value, adaptiveTransitionCuts: plan.value.transitions } }
      : result;
  }
  if (![circle.r, ...circle.c, circle.start].every(Number.isFinite)) return fail("The pocket circle is invalid.");
  const wall = circle.r - radius;
  if (wall <= MIN_MOVE) return fail("The cutter does not fit inside this pocket.");
  const outer = wall / radius;
  const rings: number[] = [];
  // The center plunge clears the initial disk. Each finished ring expands that disk.
  let previous = 0;
  while (previous < outer && rings.length < MAX_RINGS) {
    const cleared = previous + 1;
    let low = previous;
    let high = Math.min(outer, previous + 2);
    if (exposedArea(high, cleared) <= target) {
      low = high;
    } else {
      for (let i = 0; i < 40; i++) {
        const next = (low + high) / 2;
        if (exposedArea(next, cleared) <= target) low = next;
        else high = next;
      }
    }
    if ((low - previous) * radius <= MIN_MOVE) {
      return fail("The adaptive spacing is too small. Increase engagement or use a larger cutter.");
    }
    rings.push(low === outer ? wall : low * radius);
    previous = low;
  }
  if (previous < outer) return fail("The adaptive path needs too many rings. Increase engagement or use a larger cutter.");

  const { wall: perimeter, cut } = circularClearing(circle, rings);
  return preview([input], perimeter, [cut], depths.value);
}
