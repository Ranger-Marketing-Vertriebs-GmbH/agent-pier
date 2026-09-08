import fs from 'node:fs';
import path from 'node:path';
import { peersDir, peerKey } from './paths.js';
import { writeJsonAtomic, readJson, listFiles } from './fsx.js';
import { pidStart, pidStarts } from './proc.js';

export function register(h, peer) {
  const key = peerKey(peer.runtime, peer.sessionId);
  // Claude und Codex halten je Prozess genau eine Session: taucht bei gleicher PID eine neue
  // Session-ID auf (z. B. nach /clear), ist der alte Eintrag eine Leiche und muss weg.
  // Ein opencode-Prozess bedient dagegen MEHRERE Sessions gleichzeitig (`/new` in der TUI) —
  // dieselbe Regel würde dort die zuvor registrierte Session vom Bus werfen. Deren Aufräumen
  // läuft über session.deleted, __shutdown/exit und gc.
  if (peer.runtime !== 'opencode') {
    for (const other of listPeers(h, () => null)) {
      if (other.key !== key && other.runtime === peer.runtime && other.pid === peer.pid) unregister(h, other.key);
    }
  }
  writeJsonAtomic(path.join(peersDir(h), `${key}.json`), { key, ...peer });
  return key;
}

export function unregister(h, key) {
  try {
    fs.unlinkSync(path.join(peersDir(h), `${key}.json`));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

export function isAlive(peer, ps = pidStart) {
  const start = ps(peer.pid);
  return start !== null && start === peer.pidStart;
}

// Zweiter Parameter: entweder wie bisher eine ps-Funktion pro PID (so speisen die
// Tests ein) oder { starts } für einen Batch. Ohne Angabe wird gebündelt — ein
// ps-Aufruf statt einem je Peer, sonst kostet jeder Tool-Aufruf bei N Sessions
// N Prozessstarts.
export function listPeers(h, ps = pidStart) {
  const peers = [];
  for (const f of listFiles(peersDir(h))) {
    if (!f.endsWith('.json')) continue;
    try { peers.push(readJson(path.join(peersDir(h), f))); } catch { continue; }
  }
  if (typeof ps === 'function' && ps !== pidStart) {
    return peers.map((peer) => ({ ...peer, alive: isAlive(peer, ps) }));
  }
  const starts = (ps && typeof ps === 'object' && ps.starts) || pidStarts;
  const found = starts(peers.map((p) => p.pid));
  return peers.map((peer) => {
    const start = found.get(peer.pid) ?? null;
    return { ...peer, alive: start !== null && start === peer.pidStart };
  });
}

export function resolvePeer(peers, address) {
  const byKey = peers.find((p) => p.key === address);
  if (byKey) return byKey;
  const m = /^(claude|codex|opencode):(.+)$/.exec(address);
  const runtime = m ? m[1] : null;
  const name = m ? m[2] : address;
  const hits = peers.filter((p) => p.name === name && (!runtime || p.runtime === runtime));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) {
    const e = new Error(`agentbus: kein Peer "${address}"`);
    e.code = 'UNKNOWN_PEER'; e.peers = peers; throw e;
  }
  const e = new Error(`agentbus: "${address}" ist mehrdeutig: ${hits.map((p) => `${p.runtime}:${p.name}`).join(', ')}`);
  e.code = 'AMBIGUOUS'; e.candidates = hits; throw e;
}
