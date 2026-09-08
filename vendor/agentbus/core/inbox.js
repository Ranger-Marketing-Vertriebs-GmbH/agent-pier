import fs from 'node:fs';
import path from 'node:path';
import { pendingDir, doneDir } from './paths.js';
import { writeJsonAtomic, readJson, listFiles, ensureDir } from './fsx.js';
import { messageFileName } from './message.js';

export function enqueue(h, key, msg) {
  const file = path.join(pendingDir(h, key), messageFileName(msg));
  writeJsonAtomic(file, msg);
  return file;
}

// Zählt und nennt Absender. Liest nur from.name, bewegt nichts.
export function pendingSummary(h, key) {
  const dir = pendingDir(h, key);
  const senders = new Set();
  let count = 0;
  for (const f of listFiles(dir)) {
    count++;
    try {
      senders.add(readJson(path.join(dir, f)).from?.name ?? 'unbekannt');
    } catch (e) {
      // Halb geschrieben oder defekt: zählt trotzdem, Absender bleibt offen.
      senders.add('unbekannt');
      console.error(`agentbus: inbox ${key}: ${f} nicht lesbar: ${e.message}`);
    }
  }
  return { count, senders: [...senders].sort() };
}

// Reihenfolge ist Spezifikation: rename nach done/ ZUERST, dann lesen.
export function readInbox(h, key) {
  const pend = pendingDir(h, key), done = doneDir(h, key);
  const out = [];
  const files = listFiles(pend);
  if (files.length) ensureDir(done);
  for (const f of files) {
    const target = path.join(done, f);
    try {
      fs.renameSync(path.join(pend, f), target);
    } catch (e) {
      if (e.code === 'ENOENT') continue; // anderer Leser war schneller
      throw e;
    }
    // Defekte Datei bleibt in done/, wird aber gemeldet statt still zu verschwinden.
    try {
      out.push(readJson(target));
    } catch (e) {
      console.error(`agentbus: inbox ${key}: ${f} nicht lesbar: ${e.message}`);
      out.push({ id: f, malformed: true });
    }
  }
  return out;
}
