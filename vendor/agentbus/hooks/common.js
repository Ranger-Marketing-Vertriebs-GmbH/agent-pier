import fs from 'node:fs';
import path from 'node:path';
import { pendingSummary } from '../core/inbox.js';
import { nudgeText } from '../core/nudge.js';
import { peersDir, peerKey } from '../core/paths.js';
import { listPeers } from '../core/peers.js';
import { ancestors as defaultAncestors } from '../core/proc.js';
import { sanitizeName } from './register.js';

export async function readStdinJson() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s.trim() ? JSON.parse(s) : {};
}

// Claude liefert session_id; Codex bei SessionStart ebenfalls (Spike 2). Für
// UserPromptSubmit/SessionEnd ist das Codex-Payload ungemessen — siehe ownPeerKey.
export function sessionIdOf(data) {
  return data.session_id ?? data.sessionId ?? data.thread_id ?? data.conversation_id ?? null;
}

// Eigener Peer-Key: session_id aus der Payload; nur ohne session_id der registrierte Peer
// derselben Runtime, dessen PID unter den Ahnen des Hooks steht (wie mcp/self.js). Sonst null.
export function ownPeerKey(h, runtime, data, { ancestors = defaultAncestors, ps } = {}) {
  const sessionId = sessionIdOf(data);
  // Mit session_id nie über Ahnen gehen: eine verschachtelte Session (z. B. `claude -p` aus
  // einer registrierten Session heraus) würde sonst die äußere Session treffen.
  if (sessionId) return peerKey(runtime, sessionId);
  const peers = listPeers(h, ps).filter((p) => p.runtime === runtime && p.alive);
  for (const pid of ancestors(process.pid)) {
    const hit = peers.find((p) => p.pid === pid);
    if (hit) return hit.key;
  }
  return null;
}

export function runtimeArg(argv = process.argv) {
  const r = argv[2];
  if (r !== 'claude' && r !== 'codex') throw new Error('Aufruf: <script> claude|codex');
  return r;
}

export function additionalContext(event, text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

// Nur zählen und Hinweis bauen. Bewegt nichts, gibt keine Texte aus.
// Absendernamen sind Fremddaten: dieselbe Zeichenmenge wie bei der Registrierung
// (sanitizeName), gedeckelt, höchstens drei — der Hinweis landet bei opencode auch
// im System-Prompt (output.system), der Charset-Garantie aus Spec Abschnitt 10 gilt
// also an jeder Senke, nicht nur in additionalContext.
export function hintFor(h, key, runtime) {
  const { count, senders } = pendingSummary(h, key);
  if (!count) return null;
  const clean = senders.map((s) => sanitizeName(s));
  const shown = clean.slice(0, 3).join(', ') + (clean.length > 3 ? ', …' : '');
  return nudgeText(count, shown, runtime);
}
