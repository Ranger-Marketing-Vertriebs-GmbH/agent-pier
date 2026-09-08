import { execFileSync } from 'node:child_process';

// Ein ps-Feld für eine PID; null, wenn der Prozess nicht existiert.
// Feste Umgebung: lstart hängt sonst an LC_TIME/TZ des Aufrufers, und der
// pidStart-Vergleich läuft immer über zwei verschiedene Sessions.
export function psField(pid, field) {
  try {
    const out = execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export const pidStart = (pid) => psField(pid, 'lstart');

// Ab wie vielen lebenden PIDs sich die ganze Prozesstabelle lohnt. Gemessen auf
// macOS (1070 Prozesse): ein ps pro PID kostet 2,4 ms, `ps -A` 16,6 ms flach,
// und `ps -p <Liste>` ist mit 22,6 ms teurer als die ganze Tabelle — eine Liste
// zwingt ps zu einem teureren Scan. Break-even liegt damit bei rund 7.
const PS_TABLE_THRESHOLD = 6;

// Existiert der Prozess? Kostet keinen Prozessstart (0,002 ms gegenüber 2,4 ms
// für ein ps). EPERM heißt: existiert, gehört nur jemand anderem.
function exists(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Startzeiten vieler PIDs. listPeers braucht sie für jeden Peer; ein ps-Aufruf
// pro Peer bedeutete bei N Sessions N Prozessstarts je Tool-Aufruf. Tote PIDs
// werden vorher kostenlos aussortiert, der Rest je nach Anzahl einzeln oder in
// einem Tabellenaufruf geholt. Die Werte müssen byteweise denen von pidStart
// entsprechen, denn bestehende Peer-Dateien tragen genau diesen String.
export function pidStarts(pids) {
  const out = new Map();
  const live = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0 && exists(p));
  if (!live.length) return out;

  const single = () => {
    for (const pid of live) {
      const start = pidStart(pid);
      if (start !== null) out.set(pid, start);
    }
    return out;
  };
  if (live.length <= PS_TABLE_THRESHOLD) return single();

  let text;
  try {
    text = execFileSync('ps', ['-A', '-o', 'pid=,lstart='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
  } catch {
    return single();   // lieber der alte, teurere Weg als eine Falschaussage
  }
  const wanted = new Set(live);
  for (const line of text.split('\n')) {
    // Nur die PID-Spalte abtrennen; der Rest bleibt unangetastet, weil lstart
    // selbst mehrfache Leerzeichen enthält ("Sep  2").
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && wanted.has(Number(m[1]))) out.set(Number(m[1]), m[2].trim());
  }
  return out;
}

export const commOf = (pid) => psField(pid, 'comm');

export function parentPid(pid) {
  const v = psField(pid, 'ppid');
  return v ? Number(v) : null;
}

export function ancestors(pid, parent = parentPid) {
  const out = [];
  let cur = pid;
  while (out.length < 50) {
    const p = parent(cur);
    if (!p) break;
    out.push(p);
    if (p <= 1) break;
    cur = p;
  }
  return out;
}
