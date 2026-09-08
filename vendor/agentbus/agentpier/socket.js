// Adapted from AgentBus by David Kaulig (MIT); see ../LICENSE.
import fs from 'node:fs';
import net from 'node:net';
// Prüft Besitzer und Modus des Socket-Verzeichnisses, bevor gebunden wird — die
// 0700-Grenze aus Spec Abschnitt 10 gilt auch, wenn ein anderer lokaler Benutzer
// das Verzeichnis unter /tmp vorher angelegt hat. `/tmp` selbst ist 1777 und der
// Pfad `/tmp/agentbus-<uid>` vorhersagbar — ein anderer Account könnte ihn als
// Symlink auf ein Verzeichnis vorbereiten, das UNS gehört. Deshalb `lstat` statt
// `stat` (folgt Symlinks nicht) und ein expliziter Symlink-/Nicht-Verzeichnis-Test,
// bevor überhaupt Besitzer oder Modus geprüft werden — ein `chmod` über einen
// Symlink hinweg wäre sonst eine vom Angreifer ausgelöste Rechteänderung am Ziel.
// Beim Neuanlegen kein `recursive: true`: ein Fenster zwischen `lstat` (ENOENT)
// und `mkdir` erlaubt, dass jemand anders den Pfad in der Zwischenzeit anlegt;
// das macht `mkdir` dann mit EEXIST scheitern, statt es still zu akzeptieren, und
// wir prüfen im EEXIST-Fall dieselbe Validierung erneut, statt dem ersten
// (veralteten) ENOENT zu vertrauen. `lstat`/`chmod`/`mkdir` sind injizierbar: einen
// echten Fremdbesitzer-Test bräuchte einen zweiten Unix-User.
export function secureSocketDir(dir, { lstat = fs.lstatSync, chmod = fs.chmodSync, mkdir = fs.mkdirSync, uid = typeof process.getuid === 'function' ? process.getuid() : null } = {}) {
  let st;
  try {
    st = lstat(dir);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    try {
      mkdir(dir, { mode: 0o700 });        // existiert noch nicht: 0700 neu anlegen, ohne recursive
      return true;
    } catch (e2) {
      if (e2.code !== 'EEXIST') throw e2;
      // Jemand hat den Pfad im Fenster zwischen lstat und mkdir angelegt — erneut
      // validieren statt dem verschwundenen ENOENT von eben zu vertrauen.
      try {
        st = lstat(dir);
      } catch {
        return false;                     // z. B. sofort wieder verschwunden: sicherheitshalber ablehnen
      }
    }
  }
  if (st.isSymbolicLink()) return false;  // nie einem Symlink folgen, auch nicht auf eigenes Ziel
  if (!st.isDirectory()) return false;    // z. B. eine reguläre Datei am Pfad
  if (uid !== null && st.uid !== uid) return false;   // fremder Besitzer: nicht binden
  if ((st.mode & 0o777) !== 0o700) {
    try { chmod(dir, 0o700); } catch { return false; }
  }
  return true;
}

// Gibt {server, close} zurück — oder null, wenn schon jemand Lebendes lauscht.
// opencode instanziiert Plugins zweimal, deshalb ist der zweite Bind kein Fehler.
export function createSocketServer(sockPath, onText) {
  // Ein Anstoß ist eine kurze Zeile; alles darüber ist kein agentbus-Verkehr.
  const MAX = 32 * 1024;
  const onConnection = (c) => {
    let buf = '';
    c.on('data', (d) => { buf += d; if (buf.length > MAX) c.destroy(); });
    c.on('error', () => {});
    c.on('end', () => {
      try {
        const msg = JSON.parse(buf);
        if (msg && typeof msg.text === 'string') onText(msg.text, typeof msg.session === 'string' ? msg.session : null);
      } catch { /* Müll auf dem Socket ist kein Grund, die Session zu stören */ }
    });
  };
  const handleFor = (server) => ({
    server,
    close: () => new Promise((done) => {
      server.close(() => { try { fs.unlinkSync(sockPath); } catch {} done(); });
    }),
  });
  const bind = (allowTakeover) => new Promise((resolve) => {
    const server = net.createServer(onConnection);
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && allowTakeover) {
        // Belegt — lebt da noch jemand? Nur eine Leiche darf übernommen werden.
        // Niemals blind unlinken: opencode instanziiert das Plugin zweimal, und
        // die zweite Instanz würde sonst der ersten den Socket wegziehen.
        const probe = net.createConnection(sockPath);
        probe.once('connect', () => { probe.destroy(); resolve(null); });
        probe.once('error', () => {
          try { fs.unlinkSync(sockPath); } catch {}
          resolve(bind(false));          // genau ein zweiter Versuch
        });
        return;
      }
      // EADDRINUSE nach dem zweiten Versuch ist der harmlose Normalfall (die erste
      // Instanz bleibt zuständig) und bleibt still. Jeder andere Fehlercode — EACCES,
      // ENAMETOOLONG, ein zwischenzeitlich gelöschtes Verzeichnis — sieht sonst genauso
      // aus wie dieser Normalfall; den wollen wir nicht verschlucken.
      if (e.code !== 'EADDRINUSE') {
        try { process.stderr.write(`agentbus: Socket-Bind ${sockPath} fehlgeschlagen: ${e.code ?? e.message}\n`); } catch {}
      }
      resolve(null);
    });
    server.listen(sockPath, () => {
      try { fs.chmodSync(sockPath, 0o600); } catch {}
      resolve(handleFor(server));
    });
  });
  return bind(true);
}

