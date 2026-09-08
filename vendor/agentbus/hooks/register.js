import fs from 'node:fs';
import path from 'node:path';
import { claudeSessionsDir, socketPath } from '../core/paths.js';
import { pidStart, ancestors as defaultAncestors, commOf as defaultCommOf } from '../core/proc.js';
import { sessionIdOf } from './common.js';

export function claudeRegistryEntry(sessionId, dir = claudeSessionsDir(), { ps = pidStart } = {}) {
  const files = fs.readdirSync(dir);
  const matches = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let reg;
    try { reg = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (reg.sessionId !== sessionId) continue;
    const mtimeMs = fs.statSync(path.join(dir, f)).mtimeMs;
    matches.push({ reg, mtimeMs });
  }
  if (!matches.length) throw new Error(`agentbus: Session ${sessionId} nicht in ${dir}`);

  // Bevorzugt den lebenden Eintrag (crashter + --resume kann mehrere Dateien mit gleicher
  // sessionId hinterlassen); unter mehreren lebenden bzw. wenn keiner lebt, den neuesten.
  const alive = matches.filter((m) => ps(m.reg.pid) !== null);
  const pool = alive.length ? alive : matches;
  const chosen = pool.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a)).reg;

  const keyFile = files.find((k) => k.startsWith(`${chosen.pid}.`) && k.endsWith('.key'));
  if (!keyFile) throw new Error(`agentbus: keine .key-Datei für PID ${chosen.pid} in ${dir}`);
  return { pid: chosen.pid, name: chosen.name, messagingSocketPath: chosen.messagingSocketPath, keyPath: path.join(dir, keyFile) };
}

export function findRuntimePid(runtime, { ancestors = defaultAncestors, commOf = defaultCommOf, env = process.env } = {}) {
  if (env.AGENTBUS_RUNTIME_PID) return Number(env.AGENTBUS_RUNTIME_PID);
  for (const pid of ancestors(process.pid)) {
    const comm = path.basename(commOf(pid) ?? '');
    if (comm === runtime) return pid;
  }
  throw new Error(`agentbus: kein ${runtime}-Prozess unter den Ahnen des Hooks`);
}

// Namen landen in Anstoß-Rahmen und Hook-Hinweisen: nur harmlose Zeichen, gedeckelt.
export const sanitizeName = (s) => String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) || 'unbekannt';

// Die LETZTEN Zeichen der Session-ID, nicht die ersten: IDs sind bei Codex und
// opencode zeitgeordnet, zwei kurz nacheinander gestartete Sessions teilen also
// den Anfang (gemessen: "01a06394-8696-…" und "01a06394-86a8-…"). Die ersten
// Zeichen tragen keine Information, zwei Sessions im selben Verzeichnis wären
// namensgleich und in resolvePeer nicht mehr auseinanderzuhalten.
const derivedName = (cwd, sessionId) => sanitizeName(`${path.basename(cwd)}-${String(sessionId).slice(-4)}`);

export function buildPeer(runtime, data, deps = {}) {
  const { sessionsDir, ps = pidStart } = deps;
  const sessionId = sessionIdOf(data);
  if (!sessionId) throw new Error('agentbus: keine Session-ID im Hook-Payload');
  const cwd = data.cwd || process.cwd();
  let pid, name, nudge;
  if (runtime === 'claude') {
    const reg = claudeRegistryEntry(sessionId, sessionsDir, { ps });
    pid = reg.pid;
    name = reg.name ? sanitizeName(reg.name) : derivedName(cwd, sessionId);
    nudge = { kind: 'cc-socks', socketPath: reg.messagingSocketPath, keyPath: reg.keyPath, pid };
  } else if (runtime === 'opencode') {
    // Das Plugin läuft im opencode-Prozess selbst — keine Ahnen-Suche nötig.
    pid = process.pid;
    // Jede opencode-Session-ID beginnt mit "ses_" — ungekürzt wären die ersten
    // 4 Zeichen für jede Session in einem Verzeichnis identisch, resolvePeer
    // würfe AMBIGUOUS. Nur hier, nicht bei Claude/Codex, wird das Präfix vor
    // der Kürzung entfernt.
    name = derivedName(cwd, sessionId);
    nudge = { kind: 'oc-sock', socketPath: socketPath(pid, deps.env), sessionId };
  } else {
    pid = findRuntimePid('codex', deps);
    name = derivedName(cwd, sessionId);
    nudge = { kind: 'codex-queue', threadId: sessionId };
  }
  const start = ps(pid);
  if (!start) throw new Error(`agentbus: Prozess ${pid} nicht gefunden`);
  return { runtime, sessionId, pid, pidStart: start, cwd, name, nudge };
}
