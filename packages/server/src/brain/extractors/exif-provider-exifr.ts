/**
 * EXIF provider using exifr. Dynamic import — falls back to null when the
 * optional dep isn't installed.
 *
 *   npm install exifr
 *
 * Covers JPEG / HEIC / TIFF / WebP for GPS, camera model, date_taken,
 * dimensions, orientation.
 */

import type { ExifProvider } from "./image-providers.js";

const INTERESTING_TAGS = [
  "Make",
  "Model",
  "Software",
  "DateTimeOriginal",
  "CreateDate",
  "ModifyDate",
  "Orientation",
  "ExifImageWidth",
  "ExifImageHeight",
  "ImageWidth",
  "ImageHeight",
  "ISO",
  "FNumber",
  "FocalLength",
  "ExposureTime",
  "LensModel",
  "latitude",
  "longitude",
  "GPSLatitude",
  "GPSLongitude",
  "GPSAltitude",
];

export async function createExifrProvider(): Promise<ExifProvider | null> {
  let exifrMod: { parse(buffer: Buffer, opts?: unknown): Promise<unknown> };
  try {
    const m = await import("exifr" as string);
    exifrMod = (m as { default?: typeof exifrMod }).default ?? (m as unknown as typeof exifrMod);
  } catch {
    return null;
  }

  return {
    name: "exifr",
    async extract(buffer: Buffer): Promise<Record<string, unknown> | null> {
      try {
        const raw = (await exifrMod.parse(buffer, {
          pick: INTERESTING_TAGS,
          gps: true,
        })) as Record<string, unknown> | null;
        if (!raw) return null;
        return compact(raw);
      } catch {
        return null;
      }
    },
  };
}

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (v instanceof Date) {
      out[k] = Math.floor(v.getTime() / 1000);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function isExifrAvailable(): Promise<boolean> {
  try {
    await import("exifr" as string);
    return true;
  } catch {
    return false;
  }
}
