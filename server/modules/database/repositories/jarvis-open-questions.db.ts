/**
 * Jarvis mode: questions waiting for the person after their turn let the sandbox go (DECISIONS 17 in DE0CH/YYC
 * yyc-ai/refactor; jarvis-open-questions.ts keeps them in memory and writes them through here). One row per question
 * (`request_id`, the id the client answers by); `input`, `run_options` and `answer` are JSON text.
 */
import { all, run } from '@/modules/database/connection.js';

export type JarvisOpenQuestionRow = {
  request_id: string;
  session_id: string;
  provider_session_id: string | null;
  tool_name: string;
  tool_use_id: string | null;
  input: string;
  run_options: string;
  asked_at: string;
  answer: string | null;
};

export const jarvisOpenQuestionsDb = {
  async insert(row: JarvisOpenQuestionRow): Promise<void> {
    await run(
      `INSERT INTO jarvis_open_questions (request_id, session_id, provider_session_id, tool_name, tool_use_id, input, run_options, asked_at, answer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (request_id) DO NOTHING`,
      [row.request_id, row.session_id, row.provider_session_id, row.tool_name, row.tool_use_id, row.input, row.run_options, row.asked_at, row.answer],
    );
  },

  async setAnswer(requestId: string, answer: string): Promise<void> {
    await run('UPDATE jarvis_open_questions SET answer = ? WHERE request_id = ?', [answer, requestId]);
  },

  async remove(requestId: string): Promise<void> {
    await run('DELETE FROM jarvis_open_questions WHERE request_id = ?', [requestId]);
  },

  async listAll(): Promise<JarvisOpenQuestionRow[]> {
    return await all<JarvisOpenQuestionRow>('SELECT * FROM jarvis_open_questions ORDER BY asked_at ASC, request_id ASC');
  },
};
