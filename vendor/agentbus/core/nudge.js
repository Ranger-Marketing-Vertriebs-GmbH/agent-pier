import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export function nudgeText(n, fromName, targetRuntime, messageId) {
  const call = messageId ? `inbox_read(${JSON.stringify({messageId})})` : 'inbox_read';
  const base = `agentbus: ${n} neue Nachricht(en) von ${fromName} zum Versandzeitpunkt. Ruf ${call} auf`;
  const timing = ' Der Hinweis kann verzögert eintreffen; bereits abgeholte Nachrichten nicht erneut bearbeiten.';
  return targetRuntime === 'claude'
    ? `${base}; antworte mit peer_send, nicht mit SendMessage.${timing}`
    : `${base}; antworte bei Bedarf mit peer_send.${timing}`;
}

const escapeAttr = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Wire-Format aus Spec Abschnitt 4 (Claude Code 2.1.257, per Proxy mitgeschnitten).
// Attribute UND Rumpf werden escaped: sonst schließt ein Name oder Text mit
// </cross-session-message> den Rahmen und alles danach wäre Anweisung.
export function claudeWireLines(token, fromName, text) {
  const from = `agentbus:${fromName}`;
  const content = `<cross-session-message from="${escapeAttr(from)}" from-name="${escapeAttr(fromName)}" from-mode="prompting">\n${escapeAttr(text)}\n</cross-session-message>`;
  return [
    JSON.stringify({ type: 'auth', token }),
    JSON.stringify({
      msgV: 1, msg_id: crypto.randomUUID(), type: 'user',
      message: { role: 'user', content }, priority: 'next', from,
    }),
  ];
}

function defaultReadKey(keyPath) {
  // peerToken: nur lesen und senden, nie loggen oder kopieren.
  return JSON.parse(fs.readFileSync(keyPath, 'utf8')).peerToken;
}

function defaultExec(cmd, args, options = {}) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 15000, ...options }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
}

function sendSocket(socketPath, payload, timeoutMs, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    const sock = net.createConnection(socketPath);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      sock.removeListener('connect', connect);
      sock.removeListener('close', close);
      // Keep the error handler while destroy drains any pending connection error.
      sock.destroy();
      resolve(value);
    };
    const abort = () => finish(false);
    const close = () => finish(connected);
    const connect = () => {
      if (settled || signal?.aborted) { finish(false); return; }
      connected = true;
      try { sock.write(payload); sock.end(); } catch { finish(false); }
    };
    // The deadline covers connecting as well as writing/closing the socket.
    const timer = setTimeout(abort, timeoutMs);
    sock.once('error', abort);
    sock.once('connect', connect);
    sock.once('close', close);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function nudgeClaude({ socketPath, keyPath }, text, fromName, readKey, timeoutMs, signal) {
  let token;
  try { token = readKey(keyPath); } catch { return Promise.resolve(false); }
  const payload = claudeWireLines(token, fromName, text).join('\n') + '\n';
  return sendSocket(socketPath, payload, timeoutMs, signal);
}

// The socket lives in the same user's private directory. Target the exact native
// OpenCode session; never fall back to another session in the same process.
function nudgeOpencode({ socketPath, sessionId }, text, timeoutMs, signal) {
  const payload = JSON.stringify({ v: 1, text, session: sessionId }) + '\n';
  return sendSocket(socketPath, payload, timeoutMs, signal);
}

async function nudgeCodex({ threadId, command, codexHome }, text, exec) {
  if (!command || !codexHome || !threadId) return false;
  const env=Object.fromEntries(['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TMPDIR','SSL_CERT_FILE','SSL_CERT_DIR','HTTPS_PROXY','HTTP_PROXY','NO_PROXY'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
  env.CODEX_HOME=codexHome;
  try { await exec(command, ['queue', '--thread', threadId, '--message', text], { env }); return true; } catch { return false; }
}

// Erfolg heißt nur: Anstoß abgesetzt. Kein Kanal bestätigt Zustellung.
export async function nudge(peer, text, fromName, { readKey = defaultReadKey, exec = defaultExec, timeoutMs = 5000, signal } = {}) {
  if (signal?.aborted) return false;
  const n = peer?.nudge ?? {};
  if (n.kind === 'cc-socks') return nudgeClaude(n, text, fromName, readKey, timeoutMs, signal);
  if (n.kind === 'codex-queue') return nudgeCodex(n, text, exec);
  if (n.kind === 'oc-sock') return nudgeOpencode(n, text, timeoutMs, signal);
  return false;
}
