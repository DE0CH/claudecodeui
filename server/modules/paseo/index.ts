// The Paseo web app's WebSocket (docs/paseo-ui.md): the websocket module routes /paseo-ws here.
export { handlePaseoConnection } from './paseo-connection.js';
// A conversation's timeline rows, also how a shared page's snapshot is sent (jarvis-shares.ts)
export { SessionTimeline, type PaseoTimelineRow } from './paseo-timeline.js';
