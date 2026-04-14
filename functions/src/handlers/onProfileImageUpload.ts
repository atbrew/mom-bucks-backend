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
 * or overwrite. Loop prevention + memory safety:
 *   - Size check runs FIRST. If the object is already ≤ MAX_SIZE_BYTES,
 *     we never download/decode it. This also means the `resized:true`
 *     metadata flag can't be used as a bypass for oversized uploads —
 *     the flag is only honoured implicitly via the size gate.
 *   - Objects above MAX_DOWNLOAD_BYTES are rejected outright (delete
 *     the upload, don't update photoUrl). This caps our peak memory
 *     so sharp decoding can't OOM the function container, even though
 *     storage.rules permits uploads up to 100MB.
 */

import { onObjectFinalized } from "firebase-functions/v2/storage";
import { logger } from "firebase-functions";
import sharp from "sharp";
import { getFirestore, getStorage } from "../admin";

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB — target post-resize size
const MAX_DIMENSION = 1200; // px — longest edge after resize

// Hard upper bound on what the function will decode. sharp decodes
// into RAM, so a 20MB JPEG can expand to hundreds of MB of pixel
// buffer. The default 256MB function container can't survive that.
// Uploads larger than this are deleted rather than processed.
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20MB

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

    const bucket = getStorage().bucket();
    const file = bucket.file(filePath);
    const fileSize = Number(event.data.size ?? 0);

    // Size gate first. This handles three cases in one check:
    //   1. Already small enough (incl. files we resized on a previous
    //      fire) → just update photoUrl, no download/decode.
    //   2. Over MAX_SIZE_BYTES but under MAX_DOWNLOAD_BYTES → resize.
    //   3. Over MAX_DOWNLOAD_BYTES → reject, can't safely decode.
    // Putting the size check before the metadata check also closes a
    // bypass: custom metadata is client-settable, so trusting
    // `resized:true` alone would let a large upload skip resizing.
    if (fileSize <= MAX_SIZE_BYTES) {
      logger.info("[onProfileImageUpload] within size limit, updating photoUrl", {
        filePath,
        size: fileSize,
      });
      await updatePhotoUrl(parsed);
      return;
    }

    if (fileSize > MAX_DOWNLOAD_BYTES) {
      logger.warn("[onProfileImageUpload] rejecting oversized upload", {
        filePath,
        size: fileSize,
        maxDownloadBytes: MAX_DOWNLOAD_BYTES,
      });
      await file.delete({ ignoreNotFound: true });
      return;
    }

    // Download, resize, re-upload. sharp needs the full buffer to
    // decode, so we load the bounded-size file into memory. The 20MB
    // cap above keeps peak RSS well under a 512MB function container.
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
 * Single-pass resize to JPEG. With a 1200px longest-edge cap and
 * quality 80, the result is comfortably under the 5MB target for
 * every photo we accept (MAX_DOWNLOAD_BYTES = 20MB upstream).
 * Previously this looped on quality/dimension to hit a size budget,
 * but at this geometry a single pass always fits — the extra
 * decode/encode cycles just burned CPU.
 */
async function resizeToFit(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 80 })
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
