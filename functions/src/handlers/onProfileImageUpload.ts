/**
 * onProfileImageUpload — Storage trigger.
 *
 * Fires on finalize (upload complete) for profile images at:
 *   - users/{uid}/profile.jpg
 *   - children/{childId}/profile.jpg
 *
 * Responsibilities:
 *   1. If the uploaded file is >5MB, resize it using sharp and
 *      overwrite the original in Storage.
 *   2. Update the photoUrl field on the corresponding Firestore doc
 *      with the Storage path.
 *
 * The trigger uses onObjectFinalized, which fires on every new object
 * or overwrite. To avoid infinite loops (resize → re-upload → trigger
 * fires again), we check custom metadata: if `resized: "true"` is
 * present, we skip processing.
 */

import { onObjectFinalized } from "firebase-functions/v2/storage";
import { logger } from "firebase-functions";
import sharp from "sharp";
import { getFirestore, getStorage } from "../admin";

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_DIMENSION = 1200; // px — longest edge after resize

export const onProfileImageUpload = onObjectFinalized(
  { region: "us-central1" },
  async (event) => {
    const filePath = event.data.name;
    const contentType = event.data.contentType;

    if (!filePath || !contentType?.startsWith("image/")) {
      return;
    }

    // Only process profile images in known paths.
    const parsed = parseProfilePath(filePath);
    if (!parsed) {
      return;
    }

    // Skip if this upload was our own resize (prevents infinite loop).
    const metadata = event.data.metadata ?? {};
    if (metadata.resized === "true") {
      logger.info("[onProfileImageUpload] skipping already-resized file", {
        filePath,
      });
      // Still update photoUrl in case it's missing.
      await updatePhotoUrl(parsed);
      return;
    }

    const bucket = getStorage().bucket();
    const file = bucket.file(filePath);
    const fileSize = Number(event.data.size ?? 0);

    if (fileSize <= MAX_SIZE_BYTES) {
      logger.info("[onProfileImageUpload] file within size limit, updating photoUrl", {
        filePath,
        size: fileSize,
      });
      await updatePhotoUrl(parsed);
      return;
    }

    // Download, resize, re-upload.
    logger.info("[onProfileImageUpload] resizing", {
      filePath,
      originalSize: fileSize,
    });

    const [buffer] = await file.download();
    const resized = await resizeToFit(buffer);

    await file.save(resized, {
      metadata: {
        contentType: "image/jpeg",
        metadata: { resized: "true" },
      },
    });

    logger.info("[onProfileImageUpload] resized and re-uploaded", {
      filePath,
      originalSize: fileSize,
      newSize: resized.length,
    });

    await updatePhotoUrl(parsed);
  },
);

// ─── Helpers ────────────────────────────────────────────────────────

interface ProfilePath {
  collection: "users" | "children";
  docId: string;
  storagePath: string;
}

/**
 * Parse a storage path like "users/{uid}/profile.jpg" or
 * "children/{childId}/profile.jpg" into its parts.
 */
export function parseProfilePath(filePath: string): ProfilePath | null {
  const match = filePath.match(
    /^(users|children)\/([^/]+)\/profile\.jpg$/,
  );
  if (!match) return null;
  return {
    collection: match[1] as "users" | "children",
    docId: match[2],
    storagePath: filePath,
  };
}

/**
 * Progressively reduce image quality and dimensions until it fits
 * under MAX_SIZE_BYTES. Converts to JPEG for consistency.
 */
async function resizeToFit(input: Buffer): Promise<Buffer> {
  let quality = 85;
  let dimension = MAX_DIMENSION;

  while (quality >= 30) {
    const result = await sharp(input)
      .resize(dimension, dimension, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();

    if (result.length <= MAX_SIZE_BYTES) {
      return result;
    }

    // Try lower quality first, then reduce dimensions.
    if (quality > 40) {
      quality -= 15;
    } else {
      dimension = Math.round(dimension * 0.75);
      quality = 85;
    }
  }

  // Last resort: aggressive resize.
  return sharp(input)
    .resize(600, 600, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 30 })
    .toBuffer();
}

/**
 * Set the photoUrl field on the corresponding Firestore doc.
 */
async function updatePhotoUrl(parsed: ProfilePath): Promise<void> {
  const db = getFirestore();
  const docRef = db.doc(`${parsed.collection}/${parsed.docId}`);
  await docRef.set({ photoUrl: parsed.storagePath }, { merge: true });
  logger.info("[onProfileImageUpload] photoUrl updated", {
    doc: docRef.path,
    photoUrl: parsed.storagePath,
  });
}
