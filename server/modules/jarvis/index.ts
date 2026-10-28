// What other modules read of the Jarvis instance settings (jarvis-config.ts says what each one is).
export { jarvisModel, jarvisProductName, jarvisWorkspacePath } from './jarvis-config.js';
export { sentPathToWorkspaceRelative } from './jarvis-sent-files.js';
export {
  recordViewAs,
  VIEW_AS_NOT_RECORDED,
  VIEW_AS_READ_ONLY,
  viewerOf,
  type Viewer,
} from './jarvis-view-as.js';
