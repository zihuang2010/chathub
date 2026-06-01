export interface ImageFileDimensions {
  width: number;
  height: number;
}

const DEFAULT_TIMEOUT_MS = 800;

function normalizeDimensions(width: unknown, height: unknown): ImageFileDimensions | null {
  if (typeof width !== "number" || typeof height !== "number") return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

async function readWithImageBitmap(file: File): Promise<ImageFileDimensions | null> {
  if (typeof globalThis.createImageBitmap !== "function") return null;
  const bitmap = await globalThis.createImageBitmap(file);
  const dims = normalizeDimensions(bitmap.width, bitmap.height);
  bitmap.close?.();
  return dims;
}

async function readWithImageElement(file: File): Promise<ImageFileDimensions | null> {
  if (
    typeof Image === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return null;
  }

  return await new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const finish = (dims: ImageFileDimensions | null) => {
      URL.revokeObjectURL(url);
      resolve(dims);
    };
    img.onload = () => finish(normalizeDimensions(img.naturalWidth, img.naturalHeight));
    img.onerror = () => finish(null);
    img.src = url;
  });
}

export async function readImageFileDimensions(
  file: File,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ImageFileDimensions | null> {
  if (!file.type.startsWith("image/")) return null;

  const read = (async () => {
    try {
      const bitmapDims = await readWithImageBitmap(file);
      if (bitmapDims) return bitmapDims;
    } catch {
      // Some WebViews do not support createImageBitmap for all formats; fall back to <img>.
    }
    try {
      return await readWithImageElement(file);
    } catch {
      return null;
    }
  })();

  return await Promise.race([
    read,
    new Promise<null>((resolve) => {
      window.setTimeout(() => resolve(null), timeoutMs);
    }),
  ]);
}
