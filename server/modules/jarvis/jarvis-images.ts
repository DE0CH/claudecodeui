import { promises as fs } from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';

import { conversationUploads } from '@/modules/jarvis/jarvis-config.js';
import { stageAttachmentsInWorkspace } from '@/modules/jarvis/jarvis-conversations.js';
import { getGlobalImageAssetsDir, type ChatAttachmentDescriptor } from '@/shared/image-attachments.js';

/**
 * Images attached to a Jarvis 3 chat message (docs/CLAUDE-CODE.md in DE0CH/jarvis3, "Uploads").
 *
 * Every image goes to Claude twice:
 * - as an `image` content block it can SEE: a copy the Claude API accepts (JPEG/PNG/GIF/WebP, long edge at most
 *   MODEL_IMAGE_MAX_EDGE px, at most MODEL_IMAGE_MAX_BYTES), made here: iPhone HEIC/HEIF and other formats are
 *   converted to JPEG, large photos downscaled, EXIF rotation applied;
 * - as the untouched original in the conversation's /workspace/uploads/, named in the message text (an
 *   `<image_uploads>` block, stripped back out of the history the UI shows), so Claude can process it with tools.
 * An image that can't be decoded is handed over as a plain file (`<files_input>`), like any other upload.
 */

/** Long edge of the copy Claude sees. Sonnet 5.5 takes up to 2576 px; a request with more than 20 images allows
 * at most 2000 px per side, and every earlier image is re-sent with each turn, so 2000 keeps long chats valid. */
export const MODEL_IMAGE_MAX_EDGE = 2000;
/** The API refuses a base64 image over 5 MB; base64 adds a third, so the bytes stay under 3.75 MB. */
export const MODEL_IMAGE_MAX_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);

const NATIVE_TYPES: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

const IMAGE_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence', 'image/avif',
  'image/tiff', 'image/bmp', 'image/x-ms-bmp',
]);
const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.hif', '.avif', '.tif', '.tiff', '.bmp',
]);

/** Whether an upload is an image Claude can be shown (directly or after conversion). SVG is not: it stays a file. */
export function isConvertibleImage(descriptor: ChatAttachmentDescriptor): boolean {
  const mime = descriptor.mimeType?.toLowerCase();
  if (mime && IMAGE_MIME_TYPES.has(mime)) return true;
  const ext = path.extname(descriptor.name || descriptor.path).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(path.extname(descriptor.path).toLowerCase());
}

/** Decodes an HEVC-coded HEIF (iPhone photos): sharp's prebuilt libvips reads only AV1 HEIF (AVIF). */
async function decodeHeic(buffer: Buffer): Promise<sharp.Sharp> {
  const { default: decode } = await import('heic-decode');
  const { width, height, data } = await decode({ buffer });
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } });
}

/**
 * Returns a descriptor for an image Claude can be shown: the upload itself when it already fits, else a converted
 * copy next to it in the assets folder. Throws when the image can't be decoded.
 */
export async function prepareModelImage(descriptor: ChatAttachmentDescriptor): Promise<ChatAttachmentDescriptor> {
  const input = await fs.readFile(descriptor.path);
  const meta = await sharp(input).metadata();
  const nativeType = meta.format ? NATIVE_TYPES[meta.format] : undefined;
  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  const rotated = (meta.orientation ?? 1) !== 1;
  if (nativeType && longEdge <= MODEL_IMAGE_MAX_EDGE && input.length <= MODEL_IMAGE_MAX_BYTES && !rotated) {
    return { ...descriptor, mimeType: nativeType };
  }

  const heic = meta.format === 'heif' && meta.compression !== 'av1';
  // HEIC decoding applies the file's own rotation; everything else gets its EXIF orientation applied here
  const base = heic ? await decodeHeic(input) : sharp(input).rotate();
  const resized = () => base.clone().resize({
    width: MODEL_IMAGE_MAX_EDGE, height: MODEL_IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true,
  });

  let output: Buffer | null = null;
  let ext = 'jpg';
  let mimeType = 'image/jpeg';
  // transparent PNG/WebP stay PNG (a screenshot's text stays sharp) when that fits
  if (meta.hasAlpha && !heic && (meta.format === 'png' || meta.format === 'webp')) {
    const png = await resized().png({ compressionLevel: 9 }).toBuffer();
    if (png.length <= MODEL_IMAGE_MAX_BYTES) {
      output = png;
      ext = 'png';
      mimeType = 'image/png';
    }
  }
  for (const quality of [85, 70, 55]) {
    if (output) break;
    const jpeg = await resized().flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer();
    if (jpeg.length <= MODEL_IMAGE_MAX_BYTES || quality === 55) output = jpeg;
  }

  const target = path.join(getGlobalImageAssetsDir(), `${path.basename(descriptor.path)}.claude.${ext}`);
  await fs.writeFile(target, output!);
  return { ...descriptor, path: target, mimeType, size: output!.length };
}

export type JarvisAttachments = {
  /** model-ready copies, sent as image blocks */
  images: ChatAttachmentDescriptor[];
  /** files for the `<files_input>` block (already in /workspace/uploads) */
  files: unknown;
  /** the originals of `images` in /workspace/uploads, for the `<image_uploads>` block */
  savedImages: ChatAttachmentDescriptor[];
};

/**
 * Splits a turn's uploads for the sandbox: every upload's original is copied into /workspace/uploads; images get a
 * model-ready copy (prepareModelImage). Runs only in Jarvis mode, with a conversation id.
 */
export async function prepareJarvisAttachments(sessionId: string, images: unknown, files: unknown): Promise<JarvisAttachments> {
  const all = [
    ...(Array.isArray(images) ? images : []),
    ...(Array.isArray(files) ? files : []),
  ] as ChatAttachmentDescriptor[];
  const imageUploads = all.filter((d) => d && typeof d.path === 'string' && isConvertibleImage(d));
  const otherUploads = all.filter((d) => !imageUploads.includes(d));

  const stagedImages = (await stageAttachmentsInWorkspace(sessionId, imageUploads)) as ChatAttachmentDescriptor[];
  const stagedFiles = (await stageAttachmentsInWorkspace(sessionId, otherUploads)) as ChatAttachmentDescriptor[];

  const out: JarvisAttachments = { images: [], files: [...stagedFiles], savedImages: [] };
  for (let i = 0; i < imageUploads.length; i++) {
    const original = imageUploads[i];
    const saved = stagedImages[i];
    try {
      out.images.push(await prepareModelImage(original));
      // only a copy that made it into the uploads folder is worth naming (the sandbox can't see this pod's paths)
      if (saved?.path?.startsWith(`${conversationUploads(sessionId).claudePath}/`)) out.savedImages.push(saved);
    } catch (error) {
      console.warn('[jarvis] image could not be prepared for the model; sent as a file', {
        sessionId, name: original.name, error: error instanceof Error ? error.message : error,
      });
      (out.files as ChatAttachmentDescriptor[]).push(saved ?? original);
    }
  }
  return out;
}
