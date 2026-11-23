import { describe, expect, it } from "vitest";
import {
  CAM_WORLD, generateAdaptive, generateContour, generatePocket, isCamFrame, transformCamVector,
  type CamFrame, type CamOrientation, type CamVector, type ContourCurve,
} from "@whittle/cam";
import { modelEdges } from "../src/cam/modelEdges";
import { machiningPlane, projectPlanarCurves, resolveOrientation } from "../src/cam/orientation";
import type { CamCadAdapter } from "../src/cam/cadAdapter";

const setup: CamFrame = { origin: [7, 8, 9], x: [0, 1, 0], y: [-1, 0, 0], z: [0, 0, 1] };
const side: CamFrame = { origin: [4, 5, 6], x: [0, 0, 1], y: [0, -1, 0], z: [1, 0, 0] };
const circle: ContourCurve = { kind: "arc", c: [2, 3], r: 8, start: 0, sweep: Math.PI * 2 };
const near = (actual: CamVector, expected: CamVector) =>
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 10));

const cad: CamCadAdapter = {
  getCoordinateSystems: () => [{ id: "side", name: "Side" }],
  resolveCoordinateSystem: (id) => id === "side" ? side : undefined,
  resolveDatumPlane: (id) => id === "plane" ? side : undefined,
  resolveFloor: (ref) => ref.bodyId === "part" ? ref : undefined,
  resolveSketchFrame: () => undefined,
  resolveGeometry: () => undefined,
  getSelection: () => [],
};

function faceOrientation(normal: CamVector, bodyId = "part"): Extract<CamOrientation, { kind: "face" }> {
  return { kind: "face", documentId: "doc", face: {
    bodyId, center: side.origin, surface: "PLANE", normal, area: 20,
  } };
}

function orientation(source?: CamOrientation) {
  const result = resolveOrientation(cad, "doc", setup, source);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.errors.join(", "));
  expect(isCamFrame(result.value)).toBe(true);
  return result.value;
}

describe("operation machining orientation", () => {
  const tilted: CamVector = [1 / 3, 2 / 3, 2 / 3];
  it.each<CamVector>([[0, 0, 1], [0, 1, 0], tilted, [0, 0, -1]])(
    "builds a projected, right-handed face frame for normal (%s, %s, %s)", (...normal) => {
      const frame = orientation(faceOrientation(normal));
      near(frame.z, normal);
      near(frame.origin, side.origin);
      if (Math.abs(normal[1]) === 1) near(frame.x, setup.y);
      else {
        const projection = setup.x.map((v, i) => v - normal[1] * normal[i]!) as [number, number, number];
        const length = Math.hypot(...projection);
        near(frame.x, [projection[0] / length, projection[1] / length, projection[2] / length]);
      }
    },
  );

  it("uses setup Z by default, projects datum plane X and preserves the native CSYS basis", () => {
    expect(orientation()).toBe(setup);
    const plane = orientation({ kind: "plane", documentId: "doc", entityId: "plane" });
    near(plane.x, setup.x);
    near(plane.z, side.z);
    near(plane.origin, side.origin);
    expect(orientation({ kind: "csys", documentId: "doc", entityId: "side" })).toBe(side);
    const reversed = orientation({ kind: "csys", documentId: "doc", entityId: "side", flip: true });
    near(reversed.x, side.x);
    near(reversed.y, [0, 1, 0]);
    near(reversed.z, [-1, 0, 0]);
  });

  it("rejects stale, foreign and nonplanar references without falling back to setup", () => {
    for (const source of [
      faceOrientation(tilted, "deleted"),
      { ...faceOrientation(tilted), documentId: "foreign" },
      { kind: "plane", documentId: "doc", entityId: "deleted" },
      { kind: "csys", documentId: "doc", entityId: "deleted" },
    ] satisfies CamOrientation[]) {
      expect(resolveOrientation(cad, "doc", setup, source)).toMatchObject({ ok: false });
    }
    const nonplanar = { ...cad, resolveFloor: () =>
      ({ bodyId: "part", center: side.origin, normal: side.z, area: 20, surface: "CYLINDRE" }) };
    expect(resolveOrientation(nonplanar, "doc", setup, faceOrientation(side.z))).toMatchObject({ ok: false });
    expect(machiningPlane(side, CAM_WORLD.origin, CAM_WORLD)).toMatchObject({ ok: false });
  });

  it("projects side geometry and rejects edges outside the machining plane", () => {
    const edge = { curve: "LINE", ends: [[4, 5, 6], [4, 5, 10]], mid: [4, 5, 8], tangent: [0, 0, 1] } as const;
    const ref = { ...edge, bodyId: "part", length: 4 };
    const geometry = { ...cad, resolveEdge: () => edge };
    expect(modelEdges(geometry, [ref], side, false)).toEqual({ ok: true, value: [{ kind: "line", a: [0, 0], b: [4, 0] }] });
    expect(modelEdges(geometry, [ref], CAM_WORLD, false)).toMatchObject({ ok: false });
    expect(modelEdges(geometry, [ref], { ...side, origin: [2, 0, 0] }, false)).toMatchObject({ ok: false });
  });

  it.each(["contour", "pocket", "adaptive"] as const)("%s emits matching setup motion and world playback", (strategy) => {
    const source = faceOrientation(tilted);
    const frame = orientation({ ...source, flip: true });
    const boundary = orientation(source);
    const boundaryPoint = transformCamVector([0, 0, 2], boundary, CAM_WORLD, "point");
    const local = machiningPlane(frame, boundaryPoint, { ...boundary, origin: boundaryPoint });
    if (!local.ok) throw new Error(local.errors.join(", "));
    near(local.value.origin, boundaryPoint);
    const geometry = projectPlanarCurves([circle], { ...boundary, origin: boundaryPoint }, local.value);
    expect(geometry[0]).toMatchObject({ sweep: -Math.PI * 2 });

    const stock = { depth: "1.5", clearance: "2", stepover: "30" };
    const path = strategy === "contour"
      ? generateContour(geometry, local.value, local.value, { ...stock, side: "center", direction: "forward" }, 2, setup)
      : (strategy === "pocket" ? generatePocket : generateAdaptive)(
        geometry, local.value, local.value, stock, 2, [], setup,
      );
    if (!path.ok) throw new Error(path.errors.join(", "));
    expect(path.value.frame).toBe(setup);
    near(path.value.toolFrame.z, frame.z);
    const [first, ...rest] = path.value.motions;
    const expectedAxis = transformCamVector(frame.z, CAM_WORLD, setup, "direction");
    for (const motion of path.value.motions) {
      near(motion.toolAxis, expectedAxis);
      expect(Math.hypot(...motion.toolAxis)).toBeCloseTo(1, 12);
      if (motion.kind === "arc") near(motion.normal, expectedAxis);
    }
    near(transformCamVector(first!.start, setup, CAM_WORLD, "point"), path.value.pointAt(0));
    near(transformCamVector(rest.at(-1)!.end, setup, CAM_WORLD, "point"), path.value.pointAt(1));
    expect(transformCamVector(path.value.pointAt(0), CAM_WORLD, local.value, "point")[2]).toBeCloseTo(2, 10);
    expect(transformCamVector(path.value.cuttingPasses[0]![0]!, CAM_WORLD, local.value, "point")[2]).toBeCloseTo(-1.5, 10);
  });
});
