// Minimal CDP client for the user's running Chrome (remote debugging via chrome://inspect).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

export function browserWsUrl() {
  const [port, path] = readFileSync(
    `${homedir()}/Library/Application Support/Google/Chrome/DevToolsActivePort`, 'utf8'
  ).trim().split('\n');
  return `ws://127.0.0.1:${port}${path}`;
}

export async function connect() {
  const ws = new WebSocket(browserWsUrl());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('connect failed')); });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
  });
  return { send, on: (fn) => listeners.add(fn), close: () => ws.close() };
}
