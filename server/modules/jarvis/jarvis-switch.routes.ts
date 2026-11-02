/**
 * What the old router's switch module checks before `POST /__jarvis/restart` stops a person's process (DE0CH/claudecodeui
 * jarvis/router.mjs, "switch window"; DESIGN 9.6: only when the running set, holds and background work included, is
 * empty):
 *
 *   GET /api/jarvis/switch/busy → {running, processes, preparing, pending}
 *
 * Each is a list of app session ids; the process is idle when all four are empty.
 *   running   - sessionsService.listRunningSessions(): chat runs, tracked background work, turns in the Claude CLI
 *   processes - the Claude Code processes this server holds (claude-runtime activeSessions): a turn, or a process held
 *               open after its `result` for background work. A hold decided by the launch rule (a tool that reports
 *               no task, e.g. Monitor) has no tracked task, so it is in no list but this one.
 *   preparing - Paseo conversations whose sandbox is being made (paseo-hub.ts)
 *   pending   - Paseo messages sent and not yet completed (paseo-hub.ts), also in the moment before their run is
 *               registered, when `running` does not list them yet
 */
import express, { type Request, type Response } from 'express';

import { getActiveClaudeSDKSessions } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { sessionsService } from '@/modules/providers/index.js';
import { paseoHub } from '@/modules/paseo/paseo-hub.js';

export type SwitchBusy = { running: string[]; processes: string[]; preparing: string[]; pending: string[] };

export type SwitchBusyDependencies = {
  listRunning: () => Promise<Array<{ sessionId: string }>>;
  listProcesses: () => string[];
  hubState: () => { preparing: string[]; pending: string[] };
};

const defaultDependencies: SwitchBusyDependencies = {
  listRunning: () => sessionsService.listRunningSessions(),
  listProcesses: () => getActiveClaudeSDKSessions() as string[],
  hubState: () => paseoHub.busyState(),
};

export async function switchBusy(dependencies: SwitchBusyDependencies = defaultDependencies): Promise<SwitchBusy> {
  const running = (await dependencies.listRunning()).map((entry) => entry.sessionId);
  const { preparing, pending } = dependencies.hubState();
  return { running, processes: [...dependencies.listProcesses()], preparing, pending };
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
