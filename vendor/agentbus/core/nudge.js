import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export function nudgeText(n, fromName, targetRuntime) {
  const base = `agentbus: ${n} neue Nachricht(en) von ${fromName}. Ruf inbox_read auf`;
  return targetRuntime === 'claude'
    ? `${base}; antworte mit peer_send, nicht mit SendMessage.`
    : `${base}; antworte bei Bedarf mit peer_send.`;
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

function nudgeClaude({ socketPath, keyPath }, text, fromName, readKey, timeoutMs = 5000) {
  let token;
  try { token = readKey(keyPath); } catch { return Promise.resolve(false); }
  const payload = claudeWireLines(token, fromName, text).join('\n') + '\n';
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    const sock = net.createConnection(socketPath);
    sock.once('error', () => settle(false));
    sock.once('connect', () => {
      sock.removeAllListeners('error');
      const timeoutId = setTimeout(() => { timedOut = true; sock.destroy(); }, timeoutMs);
      sock.write(payload);
      sock.end();
      sock.once('close', () => { clearTimeout(timeoutId); settle(!timedOut); });
      sock.once('error', () => { clearTimeout(timeoutId); settle(false); });
    });
  });
}

// Kein Token: der Socket liegt 0600 in einem Verzeichnis mit 0700, erreichbar
// also nur für denselben Benutzer — und der darf laut Spec 10 ohnehin alles.
function nudgeOpencode({ socketPath, sessionId }, text, timeoutMs = 5000) {
  // Ein opencode-Prozess bedient mehrere Sessions über EINEN Socket, also muss der Anstoß
  // sagen, welche gemeint ist. Fehlt sessionId (Peer noch von einem älteren Commit
  // registriert), lässt JSON.stringify das Feld weg und der Empfänger fällt auf seine
  // jüngste Session zurück — siehe targetSession() in plugins/opencode/plugin.js.
  const payload = JSON.stringify({ v: 1, text, session: sessionId }) + '\n';
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    const sock = net.createConnection(socketPath);
    sock.once('error', () => settle(false));
    sock.once('connect', () => {
      sock.removeAllListeners('error');
      const timeoutId = setTimeout(() => { timedOut = true; sock.destroy(); }, timeoutMs);
      sock.write(payload);
      sock.end();
      sock.once('close', () => { clearTimeout(timeoutId); settle(!timedOut); });
      sock.once('error', () => { clearTimeout(timeoutId); settle(false); });
    });
  });
}

async function nudgeCodex({ threadId, command, codexHome }, text, exec) {
  if (!command || !codexHome || !threadId) return false;
  const env=Object.fromEntries(['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TMPDIR','SSL_CERT_FILE','SSL_CERT_DIR','HTTPS_PROXY','HTTP_PROXY','NO_PROXY'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
  env.CODEX_HOME=codexHome;
  try { await exec(command, ['queue', '--thread', threadId, '--message', text], { env }); return true; } catch { return false; }
}

// Erfolg heißt nur: Anstoß abgesetzt. Kein Kanal bestätigt Zustellung.
export async function nudge(peer, text, fromName, { readKey = defaultReadKey, exec = defaultExec, timeoutMs = 5000 } = {}) {
  const n = peer?.nudge ?? {};
  if (n.kind === 'cc-socks') return nudgeClaude(n, text, fromName, readKey, timeoutMs);
  if (n.kind === 'codex-queue') return nudgeCodex(n, text, exec);
  if (n.kind === 'oc-sock') return nudgeOpencode(n, text, timeoutMs);
  return false;
}
