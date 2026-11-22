import { describe, expect, it } from "vitest";
import type { EdgeInfo, FaceInfo } from "@whittle/kernel";
import { modelAnchor, resolveModelEdge, resolveModelFloor } from "../src/cam/modelReferences";

function plate(width: number, height: number, thickness: number) {
  const edge = (y: number, z: number): EdgeInfo => ({
    curve: "LINE", tangent: [1, 0, 0], mid: [width / 2, y, z], length: width,
  });
  const floor = (z: number): FaceInfo => ({
    surface: "PLANE", normal: [0, 0, 1], center: [width / 2, height / 2, z], area: width * height,
  });
  return {
    bbox: [[0, 0, 0], [width, height, thickness]] as [[number, number, number], [number, number, number]],
    edges: [edge(0, 0), edge(height, 0), edge(0, thickness), edge(height, thickness)],
    faces: [floor(0), floor(thickness / 2), floor(thickness)],
  };
}

describe("persistent CAM model selections", () => {
  it("rebinds to resized edges and floors even when the kernel reorders them", () => {
    const old = plate(40, 20, 5);
    const resized = plate(85, 32, 9);
    const expectedEdge = resized.edges[3]!;
    const expectedFloor = resized.faces[1]!;
    resized.edges.reverse();
    resized.faces.reverse();
    const anchor = modelAnchor(old);
    expect(resolveModelEdge(resized, { ...old.edges[3]!, bodyId: "plate", anchor })).toBe(expectedEdge);
    expect(resolveModelFloor(resized, { ...old.faces[1]!, bodyId: "plate", anchor })).toBe(expectedFloor);
  });

  it("supports older selections and rejects ambiguous or topology-changing replacements", () => {
    const old = plate(40, 20, 5);
    const resized = plate(42, 21, 5);
    expect(resolveModelEdge(resized, { ...old.edges[3]!, bodyId: "plate" })).toBe(resized.edges[3]);
    const ref = { ...old.edges[3]!, bodyId: "plate", anchor: modelAnchor(old) };
    resized.edges[2] = { ...resized.edges[3]!, mid: [21, 20.97, 5] };
    expect(resolveModelEdge(resized, ref)).toBeUndefined();
    resized.edges.pop();
    expect(resolveModelEdge(resized, ref)).toBeUndefined();
  });
});
