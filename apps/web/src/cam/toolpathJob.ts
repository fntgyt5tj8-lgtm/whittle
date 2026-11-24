import {
  buildPlanarPreview, contourPreviewData, generateAdaptive, generateCircularProfile, generateContour, generateFacing, generatePocket,
  type CamFrame, type CamResult, type CamToolpath, type CircularProfile, type ContourCurve, type ContourPreviewData,
} from "@whittle/cam";
import type { prepareMilling } from "./milling";

type MillingJob = Extract<ReturnType<typeof prepareMilling>, { ok: true }>["value"];
export type ToolpathJob = MillingJob | {
  kind: "profile";
  input: CircularProfile;
  tip: CamFrame;
  ids: readonly string[];
};
export interface GeneratedToolpath {
  path: ContourPreviewData;
  tip: CamFrame;
  ids: readonly string[];
  diameter: number;
  profile?: CamToolpath;
}

export function runToolpathJob(job: ToolpathJob): CamResult<GeneratedToolpath> {
  if (job.kind === "profile") {
    const profile = generateCircularProfile(job.input);
    if (!profile.ok) return profile;
    const { geometry, depth, clearance, side, direction, tool } = job.input;
    const circle: ContourCurve = { kind: "arc", c: geometry.center, r: geometry.radius, start: 0, sweep: direction === "ccw" ? 2 * Math.PI : -2 * Math.PI };
    const cut: ContourCurve[] = [{ ...circle, r: circle.r + (side === "inside" ? -1 : 1) * tool.diameter / 2 }];
    const frame = geometry.operationFrame;
    const preview = buildPlanarPreview([[circle]], cut, [cut], frame, frame, [-depth], clearance, undefined, undefined, job.input.workpieceCsys);
    if (!preview.ok) return preview;
    return { ok: true, value: {
      path: contourPreviewData(preview.value), tip: job.tip, ids: job.ids, diameter: tool.diameter, profile: profile.value,
    } };
  }
  const { curves, sketch, machiningFrame, settings, diameter, islands, setup, adaptive, tip, ids } = job;
  const generated = "strategy" in settings
    ? generateFacing(curves, sketch, machiningFrame, settings, diameter, setup)
    : "stepover" in settings
    ? (adaptive ? generateAdaptive : generatePocket)(curves, sketch, machiningFrame, settings, diameter, islands, setup)
    : generateContour(curves, sketch, machiningFrame, settings, diameter, setup);
  return generated.ok
    ? { ok: true, value: { path: contourPreviewData(generated.value), tip, ids, diameter } }
    : generated;
}
