// Jarvis 3: cleanup of prompt text saved in Claude Code transcripts before 2026-10-22, when the UI prepended a note to
// the first message after a sandbox release. That note is no longer sent (the managed CLAUDE.md says what survives a
// release); messages saved with it still carry it, so the history the server serves strips it.
const LEGACY_SANDBOX_RESET_NOTE =
  '[System note: your sandbox was reset since the last message: /workspace and this conversation are as they were; installed packages, running processes and files outside /workspace are gone.]';

/** The user's own text of a saved prompt: without the old sandbox-reset note in front. */
export function stripLegacySandboxResetNote(text: string): string {
  if (typeof text !== 'string' || !text.startsWith(LEGACY_SANDBOX_RESET_NOTE)) return text;
  return text.slice(LEGACY_SANDBOX_RESET_NOTE.length).replace(/^[\r\n]+/, '');
}
