/**
 * Jarvis mode: turns whose sandbox or run failed. Claude Code's transcript is the conversation's history, but a turn
 * that failed before Claude Code read it (no sandbox, the agent refused) leaves no trace there; this keeps the user's
 * text (only then) and the error that was shown, with their times (ISO), for the history to show after a reload.
 */
import { all, run } from '@/modules/database/connection.js';

export type JarvisFailedTurn = {
  id: number;
  session_id: string;
  user_text: string | null;
  user_at: string | null;
  error: string;
  error_at: string;
};

export const jarvisTurnsDb = {
  async recordFailedTurn(input: { sessionId: string; userText: string | null; userAt: string | null; error: string; errorAt: string }): Promise<void> {
    await run(
      'INSERT INTO jarvis_failed_turns (session_id, user_text, user_at, error, error_at) VALUES (?, ?, ?, ?, ?)',
      [input.sessionId, input.userText, input.userAt, input.error, input.errorAt],
    );
  },

  async listFailedTurns(sessionId: string): Promise<JarvisFailedTurn[]> {
    return await all<JarvisFailedTurn>('SELECT * FROM jarvis_failed_turns WHERE session_id = ? ORDER BY id ASC', [sessionId]);
  },
};
