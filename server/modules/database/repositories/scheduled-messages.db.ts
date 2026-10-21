import { randomUUID } from 'node:crypto';

import { all, get, run, transaction } from '@/modules/database/connection.js';

export type ScheduledMessageStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

export type ScheduledMessageRow = {
  id: string;
  user_id: number;
  session_id: string;
  content: string;
  options: string;
  scheduled_for: string;
  status: ScheduledMessageStatus;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS =
  'id, user_id, session_id, content, options, scheduled_for, status, failure_reason, created_at, updated_at';

export const scheduledMessagesDb = {
  async create(input: {
    userId: number;
    sessionId: string;
    content: string;
    options: unknown;
    scheduledFor: Date;
  }): Promise<ScheduledMessageRow> {
    const id = randomUUID();

    (await run(`INSERT INTO scheduled_messages (id, user_id, session_id, content, options, scheduled_for, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`, [id,
      input.userId,
      input.sessionId,
      input.content,
      JSON.stringify(input.options ?? {}),
      input.scheduledFor.toISOString(),]));

    return (await get(`SELECT ${COLUMNS} FROM scheduled_messages WHERE id = ?`, [id])) as ScheduledMessageRow;
  },

  /** Everything still to come or recently resolved, newest schedule first. */
  async listForSession(userId: number, sessionId: string): Promise<ScheduledMessageRow[]> {
    return (await all(`SELECT ${COLUMNS} FROM scheduled_messages
         WHERE user_id = ? AND session_id = ?
         ORDER BY scheduled_for ASC`, [userId, sessionId])) as ScheduledMessageRow[];
  },

  async listPendingForUser(userId: number): Promise<ScheduledMessageRow[]> {
    return (await all(`SELECT ${COLUMNS} FROM scheduled_messages
         WHERE user_id = ? AND status = 'pending'
         ORDER BY scheduled_for ASC`, [userId])) as ScheduledMessageRow[];
  },

  /**
   * Claims every message whose time has passed, marking them in the same
   * statement that selects them.
   *
   * Claiming is what makes a missed schedule work: the server can be down at
   * the moment a message was due, and the next poll after it starts picks the
   * message up instead of skipping it. Doing it in one transaction is what
   * stops two overlapping polls from sending the same message twice.
   */
  async claimDue(now: Date): Promise<ScheduledMessageRow[]> {
    const nowIso = now.toISOString();

    return await transaction(async () => {
      const due = (await all(`SELECT ${COLUMNS} FROM scheduled_messages
           WHERE status = 'pending' AND scheduled_for <= ?
           ORDER BY scheduled_for ASC`, [nowIso])) as ScheduledMessageRow[];

      for (const row of due) {
        (await run(`UPDATE scheduled_messages SET status = 'sent', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id]));
      }

      return due;
    });
  },

  async markFailed(id: string, reason: string): Promise<void> {
    (await run(`UPDATE scheduled_messages
         SET status = 'failed', failure_reason = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`, [reason.slice(0, 500), id]));
  },

  /**
   * Cancels a pending message, or dismisses a failed one so its banner goes
   * away. Returns false when it had already fired successfully.
   */
  async cancel(userId: number, id: string): Promise<boolean> {
    const result = (await run(`UPDATE scheduled_messages
         SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ? AND status IN ('pending', 'failed')`, [id, userId]));

    return result.changes > 0;
  },
};
