/**
 * Applies rotation + flips to an image blob using a canvas and returns a new blob.
 */
export async function transformImage(
  blob: Blob,
  rotation: number, // 0, 90, 180, 270
  flipH: boolean,
  flipV: boolean,
  mime = "image/png",
): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const swap = rotation % 180 !== 0;
  const w = swap ? bitmap.height : bitmap.width;
  const h = swap ? bitmap.width : bitmap.height;

  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), { width: w, height: h });
  (canvas as HTMLCanvasElement).width = w;
  (canvas as HTMLCanvasElement).height = h;

  const ctx = (canvas as HTMLCanvasElement).getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  ctx.translate(w / 2, h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  bitmap.close();

  if (canvas instanceof OffscreenCanvas) {
    return await canvas.convertToBlob({ type: mime });
  }
  return await new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      mime,
    );
  });
}

export function inferExtension(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return "png";
}
