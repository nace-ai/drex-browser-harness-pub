import { dataUrl } from "./shots.ts";
import type { Box, Ctx2D, FocusedEvidence, Shot } from "./types.ts";

/** Optional magnified evidence, derived from the same clean screenshot. Never a coordinate-action image. */
export async function focusedEvidence(
  shot: Shot,
  els: { box?: unknown }[] | null | undefined,
): Promise<FocusedEvidence | null> {
  const width = shot.canvas.width,
    height = shot.canvas.height,
    cssScale = shot.scale;
  if (![width, height, cssScale].every(Number.isFinite) || width <= 0 || height <= 0 || cssScale <= 0) return null;
  const vw = width / cssScale,
    vh = height / cssScale;
  const boxes = (
    (els ?? []).map((e) => e.box).filter((b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite)) as Box[]
  )
    .map(([x0, y0, x1, y1]): Box => [Math.max(0, x0), Math.max(0, y0), Math.min(vw, x1), Math.min(vh, y1)])
    .filter(([x0, y0, x1, y1]) => x1 > x0 && y1 > y0);
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map((b) => b[0])),
    top = Math.min(...boxes.map((b) => b[1]));
  const right = Math.max(...boxes.map((b) => b[2])),
    bottom = Math.max(...boxes.map((b) => b[3]));
  const bw = right - left,
    bh = bottom - top;
  // A compact public control cluster merits magnification; ordinary full-page layouts do not.
  if (bw * bh > vw * vh * 0.35 || bw > vw * 0.75 || bh > vh * 0.75) return null;
  const x = Math.max(0, left - 24),
    y = Math.max(0, top - 24);
  const w = Math.min(vw, right + 24) - x,
    h = Math.min(vh, bottom + 24) - y;
  const outW = 1280,
    outH = 800;
  const scale = Math.min(outW / w, outH / h);
  if (!Number.isFinite(scale) || scale / cssScale < 1.5) return null;
  const dx = (outW - w * scale) / 2,
    dy = (outH - h * scale) / 2;
  const canvas = new OffscreenCanvas(outW, outH),
    g = canvas.getContext("2d") as Ctx2D;
  g.fillStyle = "#e8e8e8";
  g.fillRect(0, 0, outW, outH);
  g.imageSmoothingEnabled = false;
  g.drawImage(shot.canvas, x * cssScale, y * cssScale, w * cssScale, h * cssScale, dx, dy, w * scale, h * scale);
  return {
    image: await dataUrl({ canvas }, "image/png"),
    sourceRectCSS: [x, y, w, h],
    sourceRectPixels: [x * cssScale, y * cssScale, w * cssScale, h * cssScale],
    scale,
    offset: [dx, dy],
    output: [outW, outH],
    candidateCount: boxes.length,
    use: "magnified evidence only; actions use original screenshot coordinates",
  };
}
