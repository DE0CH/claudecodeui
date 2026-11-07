// What other modules read of the Jarvis instance settings (jarvis-config.ts says what each one is).
export { jarvisModel, jarvisProductName, jarvisWorkspacePath } from './jarvis-config.js';
export { sentPathToWorkspaceRelative } from './jarvis-sent-files.js';
export {
  answerContinuation,
  ASK_SAFETY_LIMIT_MS,
  formatAskDuration,
  openQuestions,
  OpenQuestions,
  type OpenQuestion,
  type OpenQuestionClosed,
} from './jarvis-open-questions.js';
