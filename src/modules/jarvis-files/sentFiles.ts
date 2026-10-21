import { JARVIS_WORKSPACE_PATH } from '@/shared/jarvis';
import { toWorkspaceRelativePath } from '@/modules/jarvis-files/filePreview';

/** Claude Code's built-in tool for handing files to the user (enabled in the sandbox, DE0CH/jarvis3 docs/CLAUDE-CODE.md). */
export const SEND_USER_FILE_TOOL = 'SendUserFile';

type SendUserFileInput = { files: string[]; caption?: string; display?: 'render' | 'attach' };

type SentAttachment = { path?: unknown; size?: unknown };

/** The tool's input as the stream or the transcript has it (an object, or its JSON while it streams in). */
export function readSendUserFileInput(toolInput: unknown): SendUserFileInput {
  let value = toolInput;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = {};
    }
  }
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const files = Array.isArray(input.files)
    ? input.files.filter((f): f is string => typeof f === 'string')
    : typeof input.files === 'string'
      ? [input.files]
      : [];
  return {
    files,
    caption: typeof input.caption === 'string' && input.caption.trim() ? input.caption.trim() : undefined,
    display: input.display === 'render' || input.display === 'attach' ? input.display : undefined,
  };
}

type SentFile = { path: string; size: number | null };

/** The sent files inside /workspace, with the sizes the tool reported once it ran. */
export function sentFilesOf(input: SendUserFileInput, toolUseResult: unknown): SentFile[] {
  const attachments = (toolUseResult as { attachments?: SentAttachment[] } | null | undefined)?.attachments;
  const sizes = new Map<string, number>();
  if (Array.isArray(attachments)) {
    for (const a of attachments) {
      const rel = typeof a?.path === 'string' ? toWorkspaceRelativePath(a.path, JARVIS_WORKSPACE_PATH) : null;
      if (rel && typeof a.size === 'number') sizes.set(rel, a.size);
    }
  }
  const seen = new Set<string>();
  const out: SentFile[] = [];
  for (const raw of input.files) {
    const rel = toWorkspaceRelativePath(raw, JARVIS_WORKSPACE_PATH);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push({ path: rel, size: sizes.get(rel) ?? null });
  }
  return out;
}
