// pointerPath (src/accuracy.ts): a continuous pointer stroke, as a polyline or as an ellipse or arc described by its
// centre and radii, expanded here into the points Tab.pointerPath traverses with the button held. Pure: no browser, no
// switches (the caller decides whether a path is offered), and nothing here names a task or a fixed shape.
import type { ArcSpec, PathPoint, PathSpec } from "./types.ts";

/** Most points a stroke is traversed with. */
export const MAX_PATH_POINTS = 128;
/** Most points the LLM may give for a polyline (they are densified into at most MAX_PATH_POINTS). */
export const MAX_INPUT_POINTS = 64;
/** An ellipse needs at least this radius (CSS px) on each axis to be a stroke and not a click. */
export const MIN_RADIUS = 2;
/** Samples are about this far apart (CSS px) unless the budget forces them wider. */
const SPACING = 6;
const MIN_ARC_SEGMENTS = 12;

export interface Surface {
  w: number;
  h: number;
}

/** The point at an index the caller knows is there. */
export function at<T>(items: readonly T[], i: number): T {
  const item = items[i];
  if (item === undefined) throw new Error("Invalid path: no such point");
  return item;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A number the spec must hold: a missing one, a null, a string or a NaN is refused, never read as 0. */
function num(v: unknown, what: string): number {
  if (!finite(v)) throw new Error(`Invalid path: ${what} must be a finite number`);
  return v;
}

/** An optional number: missing or null means "not given"; anything else must be a finite number. */
function optional(v: unknown, what: string): number | undefined {
  return v === undefined || v === null ? undefined : num(v, what);
}

function flag(v: unknown, what: string): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") throw new Error(`Invalid path: ${what} must be true or false`);
  return v;
}

function inside(p: PathPoint, s: Surface): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < s.w && p.y < s.h;
}

function polyline(path: PathSpec, s: Surface): PathPoint[] {
  const raw: unknown = path.points;
  if (!Array.isArray(raw) || raw.length < 2) throw new Error("Invalid path: a polyline needs at least 2 points");
  if (raw.length > MAX_INPUT_POINTS) throw new Error(`Invalid path: too many points (at most ${MAX_INPUT_POINTS})`);
  const vertices: PathPoint[] = raw.map((p: unknown, i) => {
    if (!p || typeof p !== "object") throw new Error(`Invalid path: point ${i} is not a point`);
    const q = p as Record<string, unknown>;
    return { x: num(q.x, `point ${i} x`), y: num(q.y, `point ${i} y`) };
  });
  const closed = flag(path.closed, "closed");
  for (const [i, v] of vertices.entries())
    if (!inside(v, s)) throw new Error(`Invalid path: point ${i} is outside the page's visible area`);
  const first = at(vertices, 0);
  const last = at(vertices, vertices.length - 1);
  if (closed && (first.x !== last.x || first.y !== last.y)) vertices.push({ ...first });
  const lengths = vertices.slice(1).map((v, i) => Math.hypot(v.x - at(vertices, i).x, v.y - at(vertices, i).y));
  const total = lengths.reduce((a, b) => a + b, 0);
  if (!(total > 0)) throw new Error("Invalid path: the points are all the same");
  // spacing grows when the budget needs it: the sum of ceil(length / spacing) is below total / spacing + segments, and
  // the spacing is at least total / (MAX - vertices), so the result never has more than MAX_PATH_POINTS points
  const spacing = Math.max(SPACING, total / (MAX_PATH_POINTS - vertices.length));
  const out: PathPoint[] = [{ ...at(vertices, 0) }];
  for (const [i, len] of lengths.entries()) {
    if (len === 0) continue;
    const a = at(vertices, i),
      b = at(vertices, i + 1);
    const n = Math.ceil(len / spacing);
    for (let k = 1; k <= n; k++)
      out.push(k === n ? { ...b } : { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  if (out.length > MAX_PATH_POINTS) throw new Error("Invalid path: too many points");
  return out;
}

function ellipse(arc: ArcSpec, s: Surface): PathPoint[] {
  const cx = num(arc.cx, "cx"),
    cy = num(arc.cy, "cy"),
    rx = num(arc.rx, "rx"),
    ry = num(arc.ry, "ry");
  if (rx < MIN_RADIUS || ry < MIN_RADIUS) throw new Error(`Invalid path: radii must be at least ${MIN_RADIUS}`);
  const start = optional(arc.startDeg, "startDeg"),
    end = optional(arc.endDeg, "endDeg");
  const from = start ?? 0;
  const sweep = end === undefined ? 360 : end - from;
  if (!(Math.abs(sweep) > 0) || Math.abs(sweep) > 360 + 1e-6)
    throw new Error("Invalid path: the arc must sweep more than 0 and at most 360 degrees");
  const closed = flag(arc.closed, "closed");
  const whole = Math.abs(sweep) >= 360 - 1e-6;
  // Ramanujan's perimeter; the share of it the arc covers sets the number of samples
  const h = ((rx - ry) / (rx + ry)) ** 2;
  const perimeter = Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
  const reserve = closed && !whole ? 1 : 0;
  const segments = Math.min(
    MAX_PATH_POINTS - 1 - reserve,
    Math.max(MIN_ARC_SEGMENTS, Math.ceil((perimeter * Math.abs(sweep)) / 360 / SPACING)),
  );
  const out: PathPoint[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = ((from + (sweep * i) / segments) * Math.PI) / 180;
    out.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  // a whole turn ends where it began, whatever the float arithmetic says
  if (whole) out[out.length - 1] = { ...at(out, 0) };
  else if (closed) out.push({ ...at(out, 0) });
  for (const [i, p] of out.entries())
    if (!inside(p, s)) throw new Error(`Invalid path: the shape leaves the page's visible area (sample ${i})`);
  return out;
}

/** The points of a stroke inside the surface (CSS px of the viewport), in order, at most MAX_PATH_POINTS: a polyline's
 * own points with more between them, or an ellipse or arc sampled finely enough to look smooth. Throws on anything not
 * a finite number, on a polyline and an arc given together or neither, on a point or sample outside the surface, and on
 * a shape with no extent. */
export function samplePath(path: PathSpec | null | undefined, surface: Surface): PathPoint[] {
  if (!path || typeof path !== "object") throw new Error("Invalid path: missing");
  if (!finite(surface.w) || !finite(surface.h) || surface.w <= 0 || surface.h <= 0)
    throw new Error("Invalid path: no visible area");
  const hasPoints = Array.isArray(path.points) && path.points.length > 0;
  const hasArc = path.arc !== undefined && path.arc !== null;
  if (hasPoints === hasArc) throw new Error("Invalid path: give either points or an arc, not both or neither");
  if (hasPoints) return polyline(path, surface);
  const arc: unknown = path.arc;
  if (!arc || typeof arc !== "object") throw new Error("Invalid path: the arc is not an object");
  return ellipse(arc as ArcSpec, surface);
}

/** The LLM's path (strict schema: points and arc are lists, an unused one empty) as a PathSpec in CSS pixels, its
 * screenshot-pixel lengths divided by the screenshot's scale, once. Angles and flags carry over. Values are checked,
 * not coerced: a null or a string is refused, never read as 0. */
export function pathFromHelper(raw: unknown, scale: number): PathSpec {
  if (!finite(scale) || scale <= 0) throw new Error("Invalid path: bad screenshot scale");
  if (!raw || typeof raw !== "object") throw new Error("Invalid path: missing");
  const r = raw as { points?: unknown; arc?: unknown; closed?: unknown };
  const list = (v: unknown, what: string): unknown[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new Error(`Invalid path: ${what} must be a list`);
    return v;
  };
  const points = list(r.points, "points");
  const arcs = list(r.arc, "arc");
  if (arcs.length > 1) throw new Error("Invalid path: at most one arc");
  if (!points.length === !arcs.length)
    throw new Error("Invalid path: give either points or an arc, not both or neither");
  if (points.length) {
    return {
      points: points.map((p, i) => {
        if (!p || typeof p !== "object") throw new Error(`Invalid path: point ${i} is not a point`);
        const q = p as Record<string, unknown>;
        return { x: num(q.x, `point ${i} x`) / scale, y: num(q.y, `point ${i} y`) / scale };
      }),
      closed: flag(r.closed, "closed"),
    };
  }
  const a = arcs[0];
  if (!a || typeof a !== "object") throw new Error("Invalid path: the arc is not an object");
  const q = a as Record<string, unknown>;
  return {
    arc: {
      cx: num(q.cx, "cx") / scale,
      cy: num(q.cy, "cy") / scale,
      rx: num(q.rx, "rx") / scale,
      ry: num(q.ry, "ry") / scale,
      startDeg: optional(q.startDeg, "startDeg") ?? null,
      endDeg: optional(q.endDeg, "endDeg") ?? null,
      closed: flag(q.closed, "closed"),
    },
  };
}
