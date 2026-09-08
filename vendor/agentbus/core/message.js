import { ulid } from './id.js';

export const MAX_TEXT = 16 * 1024;

export function createMessage({ from, to, toName, text, replyTo }, now = Date.now(), id = ulid(now)) {
  if (typeof text !== 'string' || text.length === 0) throw new Error('agentbus: text ist leer');
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT) throw new Error('agentbus: text überschreitet 16 KiB');
  const msg = {
    id, ts: now,
    from: { runtime: from.runtime, name: from.name, sessionId: from.sessionId, cwd: from.cwd },
    to, toName, text,
  };
  if (replyTo) msg.replyTo = replyTo;
  return msg;
}

export function messageFileName(msg) {
  return `${String(msg.ts).padStart(15, '0')}-${msg.id}.json`;
}
