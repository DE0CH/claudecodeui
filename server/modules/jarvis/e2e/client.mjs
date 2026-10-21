// Drives the CloudCLI server like the router + UI would: create a session, chat.send over /ws, print frames,
// then check history, the files endpoints and delete. Usage: node client.mjs BASE_URL OWNER "prompt"
import WebSocket from 'ws';
const [base, owner, prompt] = process.argv.slice(2);
const H = { 'x-jarvis-user': owner, 'content-type': 'application/json' };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const created = await j(await fetch(`${base}/api/providers/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ provider: 'claude', projectPath: '/somewhere', initialMessage: prompt }) }));
console.log('CREATED', JSON.stringify(created));
const sessionId = created.data.sessionId;
const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { 'x-jarvis-user': owner } });
await new Promise((r, e) => { ws.on('open', r); ws.on('error', e); });
const done = new Promise((resolve) => {
  ws.on('message', (m) => {
    const f = JSON.parse(m.toString());
    const brief = { kind: f.kind, role: f.role, content: typeof f.content === 'string' ? f.content.slice(0, 200) : undefined, code: f.code, text: f.text, exitCode: f.exitCode };
    console.log('FRAME', JSON.stringify(brief));
    if (f.kind === 'complete') resolve();
  });
});
ws.send(JSON.stringify({ type: 'chat.send', sessionId, content: prompt, options: { model: 'claude-sonnet-5-5', permissionMode: 'bypassPermissions' } }));
await Promise.race([done, new Promise((r) => setTimeout(r, 120000))]);
ws.close();
console.log('RUNNING', JSON.stringify(await j(await fetch(`${base}/api/providers/sessions/running`, { headers: H }))));
console.log('MODELS', JSON.stringify(await j(await fetch(`${base}/api/providers/claude/models`, { headers: H }))));
console.log('PROJECTS', JSON.stringify(await j(await fetch(`${base}/api/projects`, { headers: H }))).slice(0, 400));
await new Promise((r) => setTimeout(r, Number(process.env.WAIT_SYNC_MS || 8000)));
const hist = await j(await fetch(`${base}/api/providers/sessions/${sessionId}/messages`, { headers: H }));
console.log('HISTORY', JSON.stringify((hist.data?.messages || []).map((m) => [m.kind, m.role, typeof m.content === 'string' ? m.content.slice(0, 120) : ''])));
console.log('FILES', JSON.stringify(await j(await fetch(`${base}/api/jarvis/sessions/${sessionId}/files`, { headers: H }))));
console.log('SESSIONID', sessionId);
const raw = process.env.RAW_PATH ? await fetch(`${base}/api/jarvis/sessions/${sessionId}/files/raw?path=${encodeURIComponent(process.env.RAW_PATH)}`, { headers: H }) : null;
if (raw) console.log('RAW', raw.status, raw.headers.get('content-disposition'), JSON.stringify(await raw.text()));
if (process.env.DELETE === '1') {
  const del = await j(await fetch(`${base}/api/providers/sessions/${sessionId}?force=true`, { method: 'DELETE', headers: H }));
  console.log('DELETED', JSON.stringify(del));
  console.log('FILES_AFTER', JSON.stringify(await j(await fetch(`${base}/api/jarvis/sessions/${sessionId}/files`, { headers: H }))));
}
