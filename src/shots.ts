// Screenshots for Drex: Image 1 is the screen, Image 2 the same screen with every usable element boxed and tagged
// (E1, E2, ...), as in ~/drex-cu/drexcu/marks.py. Images are at most 1280 px wide (Drex bills ~1,000 tokens per
// 1280x800 shot) and sent as lossy WebP so the upload stays small.

import type { Box, Ctx2D, Shot } from "./types.ts";

const MAX_WIDTH = 1280;

function b64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** A screenshot (base64 JPEG from CDP) scaled into a canvas; `scale` turns CSS pixels into image pixels. */
export async function toShot(jpegB64: string, vp: { w: number }): Promise<Shot> {
  const bmp = await createImageBitmap(b64ToBlob(jpegB64, "image/jpeg"));
  const w = Math.min(MAX_WIDTH, bmp.width);
  const h = Math.round((bmp.height * w) / bmp.width);
  const canvas = new OffscreenCanvas(w, h);
  (canvas.getContext("2d") as Ctx2D).drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return { canvas, w, h, scale: w / vp.w };
}

export function drawMarks(shot: Shot, els: { box: Box; label: string }[]): Shot {
  const c = new OffscreenCanvas(shot.w, shot.h);
  const g = c.getContext("2d") as Ctx2D;
  g.drawImage(shot.canvas, 0, 0);
  g.font = "bold 11px Arial, Helvetica, sans-serif";
  g.textBaseline = "top";
  for (const e of els) {
    const [x0, y0, x1, y1] = e.box.map((v) => v * shot.scale) as Box;
    g.strokeStyle = "rgba(0,110,255,0.82)";
    g.lineWidth = 2;
    g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    const tw = g.measureText(e.label).width;
    const ty = Math.max(y0 - 13, 0);
    g.fillStyle = "rgba(0,90,230,0.92)";
    g.fillRect(x0 - 2, ty - 1, tw + 4, 13);
    g.fillStyle = "#fff";
    g.fillText(e.label, x0, ty);
  }
  return { ...shot, canvas: c };
}

export async function dataUrl(shot: { canvas: OffscreenCanvas }, type = "image/webp", quality = 0.85): Promise<string> {
  const blob = await shot.canvas.convertToBlob({ type, quality });
  return await new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.readAsDataURL(blob);
  });
}

/** A small copy for the run log (one per move): enough to see what Drex saw, ~20-40 KB as JPEG. */
export async function thumb(shot: Shot, width = 640): Promise<string> {
  const w = Math.min(width, shot.w);
  const h = Math.round((shot.h * w) / shot.w);
  const c = new OffscreenCanvas(w, h);
  (c.getContext("2d") as Ctx2D).drawImage(shot.canvas, 0, 0, w, h);
  return dataUrl({ canvas: c }, "image/jpeg", 0.6);
}
