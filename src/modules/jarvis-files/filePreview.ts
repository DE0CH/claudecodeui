/** How the Files panel can show a file before it is downloaded. */
export type PreviewKind = 'image' | 'pdf' | 'text' | 'none';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yaml', 'yml', 'xml', 'html', 'htm']);

/** Text previews are read in full, so only small files get one. */
export const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

export function fileExtension(filePath: string): string {
  const name = fileName(filePath);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function fileName(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

export function fileDirectory(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index > 0 ? filePath.slice(0, index) : '';
}

export function previewKind(filePath: string, size: number): PreviewKind {
  const extension = fileExtension(filePath);
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (extension === 'pdf') return 'pdf';
  if (TEXT_EXTENSIONS.has(extension) && size <= TEXT_PREVIEW_MAX_BYTES) return 'text';
  return 'none';
}

/** Bytes in the units staff expect (1 KB = 1,024 bytes), one decimal from KB up. */
export function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * A path the chat links to (absolute under /workspace, or relative) as the Files panel's relative
 * path, or null when it points outside the conversation's workspace.
 */
export function toWorkspaceRelativePath(filePath: string, workspaceRoot: string): string | null {
  let value = filePath.trim().replace(/\\/g, '/');
  if (value.startsWith('file://')) value = value.slice('file://'.length);
  const root = workspaceRoot.replace(/\/+$/, '');
  if (value === root) return null;
  if (value.startsWith(`${root}/`)) value = value.slice(root.length + 1);
  else if (value.startsWith('/')) return null;
  value = value.replace(/^\.\//, '');
  if (!value || value.split('/').some((segment) => segment === '..')) return null;
  return value;
}
