export type CamVector = readonly [number, number, number];

/** Right-handed orthonormal frame in a shared reference space. Lengths are in mm. */
export interface CamFrame {
  readonly origin: CamVector;
  readonly x: CamVector;
  readonly y: CamVector;
  readonly z: CamVector;
}

export const CAM_WORLD: CamFrame = {
  origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1],
};

export function dot(a: CamVector, b: CamVector) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a: CamVector, b: CamVector): CamVector {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function subtract(a: CamVector, b: CamVector): CamVector {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function unit(v: CamVector): CamVector {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** Prefer projected setup X, falling back to setup Y near the projection singularity. */
export function normalFrame(origin: CamVector, normal: CamVector, setup: CamFrame): CamFrame | undefined {
  if (!origin.every(Number.isFinite) || !normal.every(Number.isFinite) || Math.hypot(...normal) < 1e-10) return;
  const z = unit(normal);
  const tangent = cross(Math.abs(dot(setup.x, z)) < 0.9999 ? setup.x : setup.y, z);
  const x = unit(cross(z, tangent));
  return { origin, x, y: unit(cross(z, x)), z };
}

export function flipCamFrame(frame: CamFrame): CamFrame {
  const negate = ([x, y, z]: CamVector): CamVector => [-x, -y, -z];
  return { ...frame, y: negate(frame.y), z: negate(frame.z) };
}

/** Move only along the tool axis so cutting depths are relative to the boundary. */
export function camPlaneAt(frame: CamFrame, point: CamVector): CamFrame {
  const height = dot(subtract(point, frame.origin), frame.z);
  return { ...frame, origin: [
    frame.origin[0] + height * frame.z[0],
    frame.origin[1] + height * frame.z[1],
    frame.origin[2] + height * frame.z[2],
  ] };
}

export function isUnit(v: CamVector) {
  return Math.abs(dot(v, v) - 1) <= 1e-9;
}

export function isCamFrame(frame: CamFrame): boolean {
  const { origin, x, y, z } = frame;
  return origin.every(Number.isFinite) && [x, y, z].every(isUnit) &&
    Math.abs(dot(x, y)) <= 1e-9 && Math.hypot(...subtract(cross(x, y), z)) <= 1e-9;
}

/** Convert coordinates from one valid frame to another. Directions omit origin translation. */
export function transformCamVector(
  v: CamVector, from: CamFrame, to: CamFrame, kind: "point" | "direction",
): CamVector {
  const offset = kind === "point" ? subtract(from.origin, to.origin) : CAM_WORLD.origin;
  const shared: CamVector = [
    offset[0] + v[0] * from.x[0] + v[1] * from.y[0] + v[2] * from.z[0],
    offset[1] + v[0] * from.x[1] + v[1] * from.y[1] + v[2] * from.z[1],
    offset[2] + v[0] * from.x[2] + v[1] * from.y[2] + v[2] * from.z[2],
  ];
  return [dot(shared, to.x), dot(shared, to.y), dot(shared, to.z)];
}
