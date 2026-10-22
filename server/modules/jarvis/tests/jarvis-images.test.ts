import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { resetJarvisInstanceConfig } from '@/modules/jarvis/jarvis-config.js';
import {
  isConvertibleImage,
  MODEL_IMAGE_MAX_BYTES,
  MODEL_IMAGE_MAX_EDGE,
  prepareJarvisAttachments,
  prepareModelImage,
} from '@/modules/jarvis/jarvis-images.js';
import { appendFilesInputTag, appendImageUploadsTag, parseFilesInputTag, parseImageUploadsTag } from '@/shared/image-attachments.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Jarvis mode with HOME (the upload store is ~/.claude/cloudcli-assets) and the JuiceFS root in a temp folder. */
async function withJarvisHome(run: (ctx: { assets: string; jfs: string }) => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  const temp = await mkdtemp(path.join(os.tmpdir(), 'jarvis-images-'));
  process.env.HOME = temp;
  process.env.JARVIS_WEB_URL = 'http://127.0.0.1:9';
  process.env.JARVIS_JFS_ROOT = path.join(temp, 'jfs');
  process.env.JARVIS_CONFIG = path.join(temp, 'no-config.json');
  resetJarvisInstanceConfig();
  const assets = path.join(temp, '.claude', 'cloudcli-assets');
  await mkdir(assets, { recursive: true });
  try {
    await run({ assets, jfs: path.join(temp, 'jfs') });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    resetJarvisInstanceConfig();
    await rm(temp, { recursive: true, force: true });
  }
}

async function makeJpeg(file: string, width: number, height: number, orientation?: number): Promise<void> {
  let image = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg({ quality: 90 });
  if (orientation) image = image.withMetadata({ orientation });
  await writeFile(file, await image.toBuffer());
}

test('which uploads count as images Claude can be shown', () => {
  assert.equal(isConvertibleImage({ path: '/a/1-IMG_0001.HEIC' }), true);
  assert.equal(isConvertibleImage({ path: '/a/x', mimeType: 'image/heic' }), true);
  assert.equal(isConvertibleImage({ path: '/a/photo.jpg' }), true);
  assert.equal(isConvertibleImage({ path: '/a/x', name: 'scan.tiff' }), true);
  assert.equal(isConvertibleImage({ path: '/a/logo.svg', mimeType: 'image/svg+xml' }), false);
  assert.equal(isConvertibleImage({ path: '/a/report.pdf', mimeType: 'application/pdf' }), false);
});

test('a small JPEG is sent as it is', async () => {
  await withJarvisHome(async ({ assets }) => {
    const file = path.join(assets, '1-small.jpg');
    await makeJpeg(file, 800, 600);
    const prepared = await prepareModelImage({ path: file, name: 'small.jpg', mimeType: 'application/octet-stream' });
    assert.equal(prepared.path, file);
    assert.equal(prepared.mimeType, 'image/jpeg');
  });
});

test('a large photo is downscaled to the model size, its EXIF rotation applied', async () => {
  await withJarvisHome(async ({ assets }) => {
    const file = path.join(assets, '1-big.jpg');
    // 6000x4000 stored, orientation 6 = shown rotated 90°, i.e. 4000x6000 upright
    await makeJpeg(file, 6000, 4000, 6);
    const prepared = await prepareModelImage({ path: file, name: 'big.jpg', mimeType: 'image/jpeg' });
    assert.notEqual(prepared.path, file);
    assert.equal(path.dirname(prepared.path), assets);
    assert.equal(prepared.mimeType, 'image/jpeg');
    const meta = await sharp(prepared.path).metadata();
    assert.equal(meta.height, MODEL_IMAGE_MAX_EDGE);
    assert.equal(meta.width, Math.round((4000 / 6000) * MODEL_IMAGE_MAX_EDGE));
    assert.ok((await stat(prepared.path)).size <= MODEL_IMAGE_MAX_BYTES);
    // the original is untouched
    assert.equal((await sharp(file).metadata()).width, 6000);
  });
});

test('an iPhone HEIC photo becomes a JPEG Claude can see', async () => {
  await withJarvisHome(async ({ assets }) => {
    const file = path.join(assets, '1-IMG_0001.HEIC');
    await copyFile(path.join(FIXTURES, 'tiny.heic'), file);
    const prepared = await prepareModelImage({ path: file, name: 'IMG_0001.HEIC', mimeType: 'image/heic' });
    assert.equal(prepared.mimeType, 'image/jpeg');
    assert.match(prepared.path, /1-IMG_0001\.HEIC\.claude\.jpg$/);
    const meta = await sharp(prepared.path).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 640, 480]);
  });
});

test('a large transparent PNG stays a PNG', async () => {
  await withJarvisHome(async ({ assets }) => {
    const file = path.join(assets, '1-shot.png');
    await writeFile(file, await sharp({ create: { width: 3000, height: 1000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer());
    const prepared = await prepareModelImage({ path: file, name: 'shot.png', mimeType: 'image/png' });
    assert.equal(prepared.mimeType, 'image/png');
    assert.equal((await sharp(prepared.path).metadata()).width, MODEL_IMAGE_MAX_EDGE);
  });
});

test('a turn\'s uploads: originals in /workspace/uploads, images also as model copies, broken images as files', async () => {
  await withJarvisHome(async ({ assets, jfs }) => {
    const sessionId = randomUUID();
    const heic = path.join(assets, '1-IMG_0001.HEIC');
    await copyFile(path.join(FIXTURES, 'tiny.heic'), heic);
    const broken = path.join(assets, '2-broken.jpg');
    await writeFile(broken, 'not an image');
    const pdf = path.join(assets, '3-report.pdf');
    await writeFile(pdf, '%PDF-1.4');

    const out = await prepareJarvisAttachments(
      sessionId,
      [{ path: broken, name: 'broken.jpg', mimeType: 'image/jpeg' }],
      [{ path: heic, name: 'IMG_0001.HEIC', mimeType: 'image/heic' }, { path: pdf, name: 'report.pdf', mimeType: 'application/pdf' }],
    );
    assert.deepEqual(out.images.map((i) => [path.basename(i.path), i.mimeType]), [['1-IMG_0001.HEIC.claude.jpg', 'image/jpeg']]);
    assert.deepEqual(out.savedImages.map((i) => [i.path, i.name]), [['/workspace/uploads/IMG_0001.HEIC', 'IMG_0001.HEIC']]);
    assert.deepEqual((out.files as Array<{ path: string }>).map((f) => f.path).sort(), ['/workspace/uploads/broken.jpg', '/workspace/uploads/report.pdf']);
    // the original bytes are in the conversation's workspace
    assert.deepEqual(await readFile(path.join(jfs, 'ws', sessionId, 'uploads', 'IMG_0001.HEIC')), await readFile(path.join(FIXTURES, 'tiny.heic')));
  });
});

test('the image paths block reaches Claude and is stripped from the history', () => {
  const prompt = appendImageUploadsTag(
    appendFilesInputTag('這張相片是甚麼？', [{ path: '/workspace/uploads/report.pdf', name: 'report.pdf' }]),
    [{ path: '/workspace/uploads/IMG_0001.HEIC', name: 'IMG_0001.HEIC' }],
  );
  assert.match(prompt, /<image_uploads>[\s\S]*1\. \/workspace\/uploads\/IMG_0001\.HEIC \(original name: IMG_0001\.HEIC\)[\s\S]*<\/image_uploads>$/);
  const images = parseImageUploadsTag(prompt);
  assert.deepEqual(images.attachments, [{ path: '/workspace/uploads/IMG_0001.HEIC', name: 'IMG_0001.HEIC' }]);
  const files = parseFilesInputTag(images.text);
  assert.equal(files.text, '這張相片是甚麼？');
  assert.deepEqual(files.attachments, [{ path: '/workspace/uploads/report.pdf', name: 'report.pdf' }]);
  assert.equal(appendImageUploadsTag('hi', []), 'hi');
  assert.equal(parseImageUploadsTag('hi').text, 'hi');
});
