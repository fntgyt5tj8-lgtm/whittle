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
