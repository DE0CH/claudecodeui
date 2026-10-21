// Minimal Anthropic Messages API stand-in for the local e2e (no real model calls, no cost).
// MOCK_MODE=ok (default): every /v1/messages answers "Hello from the mock model."; MOCK_MODE=budget: 402 budget_exceeded.
import http from 'node:http';
const port = Number(process.env.MOCK_PORT || 18080);
let mode = process.env.MOCK_MODE || 'ok';
const log = [];
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/__mode') { mode = body.trim(); res.end('ok'); return; }
    if (req.url === '/__log') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(log)); return; }
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch {}
    log.push({ url: req.url, model: parsed.model, stream: parsed.stream });
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(404); res.end('{}'); return; }
    if (req.url.startsWith('/v1/messages/count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":10}'); return; }
    if (mode === 'budget') {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'budget_exceeded', message: 'The administrator has set a USD 50 budget limit and it has now been used up.' } }));
      return;
    }
    const hasToolResult = JSON.stringify(parsed.messages || []).includes('tool_result');
    const isMainTurn = Array.isArray(parsed.tools) && parsed.tools.some((t) => t.name === 'Write');
    if (mode === 'write' && isMainTurn && !hasToolResult) {
      const tmsg = { id: 'msg_mock_t' + Date.now(), type: 'message', role: 'assistant', model: parsed.model || 'claude-mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: tmsg });
      ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_mock_1', name: 'Write', input: {} } });
      ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: '/workspace/report/hello.txt', content: 'written in the sandbox\n' }) } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
      ev('message_stop', {});
      res.end();
      return;
    }
    const text = 'Hello from the mock model.';
    const msg = { id: 'msg_mock_' + Date.now(), type: 'message', role: 'assistant', model: parsed.model || 'claude-mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
    if (!parsed.stream) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...msg, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 6 } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: msg });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } });
    ev('message_stop', {});
    res.end();
  });
}).listen(port, '127.0.0.1', () => console.log(`mock anthropic on ${port}`));
