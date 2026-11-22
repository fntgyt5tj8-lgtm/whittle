import { EndType, inflatePaths, JoinType, pointInPolygon, PointInPolygonResult, simplifyPaths, type Paths64, type Point64 } from "clipper2-ts";

const MAX_WAYPOINTS = 48;
const MAX_LENGTH_RATIO = 3;
const distance = (a: Point64, b: Point64) => Math.hypot(a.x - b.x, a.y - b.y);

/** Find a short route between two points in the existing cleared cutter-center region. */
export function findAdaptiveDetour(
  from: Point64, to: Point64, cleared: Paths64, linkRadius: number, arcTolerance: number,
  certify: (a: Point64, b: Point64) => boolean,
): Point64[] | undefined {
  const direct = distance(from, to);
  if (!direct) return;
  // Leave a little room for chords joining successive vertices around a hole.
  const margin = Math.max(12, linkRadius * 0.025);
  const interior = inflatePaths(cleared, -(linkRadius + margin), JoinType.Round, EndType.Polygon, 2, arcTolerance);
  const inside = (point: Point64) => interior.filter((path) =>
    pointInPolygon(point, path) === PointInPolygonResult.IsInside).length % 2 === 1;
  if (!inside(from) || !inside(to)) return;

  const maxLength = direct * MAX_LENGTH_RATIO;
  const corners = simplifyPaths(interior, margin / 4)
    .flat().filter((p) => distance(from, p) + distance(p, to) <= maxLength
      && distance(p, from) > 1 && distance(p, to) > 1);
  const stride = Math.max(1, Math.ceil(corners.length / MAX_WAYPOINTS));
  const nodes = [from, to, ...corners.filter((_, i) => i % stride === 0)];
  const best = nodes.map(() => Infinity);
  const prior = nodes.map(() => -1);
  const settled = nodes.map(() => false);
  const remaining = nodes.map((point) => distance(point, to));
  best[0] = 0;

  // A* over the offset vertices. Only certified edges enter the search.
  for (let step = 0; step < nodes.length; step++) {
    let at = -1;
    let score = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const estimate = best[i]! + remaining[i]!;
      if (settled[i] || estimate >= score) continue;
      at = i;
      score = estimate;
    }
    if (at < 0 || score > maxLength) break;
    if (at === 1) {
      const waypoints: Point64[] = [];
      for (let i = prior[1]!; i > 0; i = prior[i]!) waypoints.push(nodes[i]!);
      return waypoints.length ? waypoints.reverse() : undefined;
    }
    settled[at] = true;
    for (let i = 1; i < nodes.length; i++) {
      if (settled[i] || (at === 0 && i === 1)) continue;
      const next = best[at]! + distance(nodes[at]!, nodes[i]!);
      if (next >= best[i]! || next + remaining[i]! > maxLength || !certify(nodes[at]!, nodes[i]!)) continue;
      best[i] = next;
      prior[i] = at;
    }
  }
}
