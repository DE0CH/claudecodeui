import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildStoredAttachmentRecords,
  buildStoredImageRecords,
  isAllowedImageMimeType,
  resolveAttachmentAssetFile,
  resolveImageAssetFile,
  utf8FileName,
} from '@/modules/assets/services/image-assets.service.js';

const ASSETS_DIR = path.join(os.homedir(), '.cloudcli', 'assets');

test('isAllowedImageMimeType accepts image formats and rejects the rest', () => {
  assert.equal(isAllowedImageMimeType('image/png'), true);
  assert.equal(isAllowedImageMimeType('image/svg+xml'), true);
  assert.equal(isAllowedImageMimeType('application/pdf'), false);
  assert.equal(isAllowedImageMimeType('text/html'), false);
});

test('buildStoredImageRecords returns absolute posix paths in the assets dir', () => {
  const records = buildStoredImageRecords([
    { originalname: 'shot.png', filename: '123-456-shot.png', size: 42, mimetype: 'image/png' },
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'shot.png');
  assert.equal(records[0].size, 42);
  assert.equal(records[0].mimeType, 'image/png');
  assert.equal(records[0].path, `${ASSETS_DIR.replace(/\\/g, '/')}/123-456-shot.png`);
});

test('buildStoredAttachmentRecords preserves metadata for non-image files', () => {
  const records = buildStoredAttachmentRecords([
    {
      originalname: 'requirements.pdf',
      filename: '123-456-requirements.pdf',
      size: 2048,
      mimetype: 'application/pdf',
    },
  ]);

  assert.deepEqual(records[0], {
    name: 'requirements.pdf',
    path: `${ASSETS_DIR.replace(/\\/g, '/')}/123-456-requirements.pdf`,
    size: 2048,
    mimeType: 'application/pdf',
  });
});

test('resolveImageAssetFile resolves plain filenames inside the assets dir', () => {
  const resolved = resolveImageAssetFile('123-shot.png');
  assert.equal(resolved, path.join(path.resolve(ASSETS_DIR), '123-shot.png'));
});

test('resolveImageAssetFile rejects traversal and separator attempts', () => {
  assert.equal(resolveImageAssetFile(''), null);
  assert.equal(resolveImageAssetFile('   '), null);
  assert.equal(resolveImageAssetFile('../auth.db'), null);
  assert.equal(resolveImageAssetFile('..'), null);
  assert.equal(resolveImageAssetFile('sub/dir.png'), null);
  assert.equal(resolveImageAssetFile('sub\\dir.png'), null);
  assert.equal(resolveImageAssetFile('a..b/../c.png'), null);
});

test('resolveAttachmentAssetFile uses the same direct-child boundary', () => {
  assert.equal(
    resolveAttachmentAssetFile('123-notes.txt'),
    path.join(path.resolve(ASSETS_DIR), '123-notes.txt'),
  );
  assert.equal(resolveAttachmentAssetFile('../notes.txt'), null);
});

test('utf8FileName reads a UTF-8 file name multer took as Latin-1 again, and keeps every other name', () => {
  const name = 'Surgical Futures Forum【Registration Form】- Master 預約.xlsx';
  const asMulterGotIt = Buffer.from(name, 'utf8').toString('latin1');
  assert.notEqual(asMulterGotIt, name);
  assert.equal(utf8FileName(asMulterGotIt), name);
  assert.equal(buildStoredAttachmentRecords([{ originalname: asMulterGotIt, filename: 'x.xlsx', size: 1, mimetype: 'application/octet-stream' }])[0]?.name, name);
  assert.equal(utf8FileName('report (final).pdf'), 'report (final).pdf');
  assert.equal(utf8FileName(name), name, 'already decoded (filename*)');
  assert.equal(utf8FileName('caf\u00e9.txt'), 'caf\u00e9.txt', 'Latin-1 bytes that are not UTF-8');
  assert.equal(utf8FileName(''), '');
});
