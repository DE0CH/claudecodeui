/**
 * Copies a file or folder tree on the JuiceFS volume with `juicefs clone` (copy-on-write: metadata only, the data
 * blocks are shared until either side changes; about 0.1 s whatever the size), or with a plain recursive copy where
 * there is no juicefs binary (local mode, tests). Symlinks are copied as links, never followed.
 *   JARVIS_JUICEFS [/usr/local/bin/juicefs]   the client binary (the official static build; it talks to the mount
 *                                              through its .control file, no credentials)
 */
import { execFile } from 'node:child_process';
import { access, cp, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

export function juicefsBinary(): string {
  return process.env.JARVIS_JUICEFS || '/usr/local/bin/juicefs';
}

async function haveJuicefs(): Promise<boolean> {
  try {
    await access(juicefsBinary(), fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `src` (a file or folder) to `dst`, which must not exist yet; its parent folder is made. */
export async function cloneTree(src: string, dst: string): Promise<void> {
  await mkdir(path.dirname(dst), { recursive: true });
  if (await haveJuicefs()) {
    await new Promise<void>((resolve, reject) => {
      execFile(juicefsBinary(), ['clone', src, dst], { timeout: 120_000 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`juicefs clone failed: ${String(stderr || error.message).trim().slice(0, 300)}`));
        else resolve();
      });
    });
    return;
  }
  await cp(src, dst, { recursive: true, verbatimSymlinks: true, errorOnExist: false, force: false });
}
