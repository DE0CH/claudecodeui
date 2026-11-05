/**
 * What the old router's switch module checks before `POST /__jarvis/restart` stops a person's process (DE0CH/claudecodeui
 * jarvis/router.mjs, "switch window"; DESIGN 9.6: only when the running set, holds and background work included, is
 * empty):
 *
 *   GET /api/jarvis/switch/busy → {running, processes, preparing, pending, asking}
 *
 * The first four are lists of app session ids; the process is idle when all four are empty.
 *   running   - sessionsService.listRunningSessions(): chat runs, tracked background work, turns in the Claude CLI
 *   processes - the Claude Code processes this server holds (claude-runtime activeSessions): a turn, or a process held
 *               open after its `result` for background work. A hold decided by the launch rule (a tool that reports
 *               no task, e.g. Monitor) has no tracked task, so it is in no list but this one.
 *   preparing - Paseo conversations whose sandbox is being made (paseo-hub.ts)
 *   pending   - Paseo messages sent and not yet completed (paseo-hub.ts), also in the moment before their run is
 *               registered, when `running` does not list them yet
 *   asking    - questions waiting for the person after their turn let its Claude Code process and sandbox go
 *               (DECISIONS 17 in DE0CH/YYC yyc-ai/refactor; jarvis-open-questions.ts), one entry per question:
 *               {sessionId, requestId, toolName, toolUseId, askedAt, answered}. Not running work: no turn, no process,
 *               no sandbox held, so it does not make the process busy (the router reads only the four lists above).
 *               The question is kept in this process's database (jarvis_open_questions), so a restart keeps it;
 *               the list is for the switch's importer, which must not hand a conversation over without its question.
 *               An answered one waits only for its turn to start (it then leaves this list and is in `running`).
 */
import express, { type Request, type Response } from 'express';

import { getActiveClaudeSDKSessions, listClaudeSDKOpenQuestions } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { sessionsService } from '@/modules/providers/index.js';
import { paseoHub } from '@/modules/paseo/paseo-hub.js';
import type { OpenQuestionSummary } from '@/shared/types.js';

export type SwitchBusy = {
  running: string[];
  processes: string[];
  preparing: string[];
  pending: string[];
  asking: OpenQuestionSummary[];
};

export type SwitchBusyDependencies = {
  listRunning: () => Promise<Array<{ sessionId: string }>>;
  listProcesses: () => string[];
  hubState: () => { preparing: string[]; pending: string[] };
  listAsking?: () => OpenQuestionSummary[];
};

const defaultDependencies: SwitchBusyDependencies = {
  listRunning: () => sessionsService.listRunningSessions(),
  listProcesses: () => getActiveClaudeSDKSessions() as string[],
  hubState: () => paseoHub.busyState(),
  listAsking: () => listClaudeSDKOpenQuestions() as OpenQuestionSummary[],
};

export async function switchBusy(dependencies: SwitchBusyDependencies = defaultDependencies): Promise<SwitchBusy> {
  const running = (await dependencies.listRunning()).map((entry) => entry.sessionId);
  const { preparing, pending } = dependencies.hubState();
  return { running, processes: [...dependencies.listProcesses()], preparing, pending, asking: dependencies.listAsking?.() ?? [] };
}

export function createJarvisSwitchRouter(dependencies: SwitchBusyDependencies = defaultDependencies): express.Router {
  const router = express.Router();
  router.get('/switch/busy', async (_req: Request, res: Response) => {
    try {
      res.json(await switchBusy(dependencies));
    } catch (error) {
      // the router reads anything but a 200 as "can't tell" and keeps the process
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  return router;
}
