export const assistantSshCopy = {
  row: "SSH-Zugänge",
  none: "Keine",
  summary: (hosts, trusted) =>
    `${hosts} ${hosts === 1 ? "Host" : "Hosts"}${trusted > 0 ? ` · ${trusted} vertraut` : ""}`,
  title: "SSH-Zugänge",
  intro:
    "Hosts, auf denen dieser Agent Befehle ausführen darf. Schlüssel und Host-Schlüssel bleiben in AgentPier.",
  search: "Hosts suchen",
  noMatch: "Kein Host passt zur Suche.",
  empty: "Es gibt noch keine SSH-Zugänge.",
  manage: "SSH-Zugänge einrichten",
  loading: "SSH-Zugänge werden geladen …",
  loadError: "SSH-Zugänge konnten nicht geladen werden.",
  removed: "Host entfernt",
  removedHint: "Diesen Host gibt es nicht mehr. Er wird beim Speichern entfernt.",
  project: (name) => `Projekt: ${name}`,
  endpoint: (user, host, port) => `${user}@${host}:${port}`,
  modeLegend: "Modus",
  sftp: "SFTP",
  modes: {
    approval: "Mit Freigabe",
    trusted: "Vertraut",
  },
  modeHints: {
    approval: "Du bestätigst jeden Befehl.",
    trusted:
      "Läuft ohne Rückfrage in deinen Chats, in Aufträgen des leitenden Agenten und in Routinen.",
  },
  trustedWarning:
    "Befehle, die dieser Agent aus Webseiten oder Dateien ableitet, könnten ohne deine Bestätigung laufen.",
  sftpModeHints: {
    approval: "Lesen läuft ohne Rückfrage, jede Änderung fragt nach.",
    trusted:
      "Änderungen laufen ohne Rückfrage, auch in Routinen. Löschen fragt immer nach; Routinen löschen nie.",
  },
  sftpTrustedWarning:
    "Übertragungen, die dieser Agent aus Webseiten oder Dateien ableitet, könnten ohne deine Bestätigung laufen.",
  card: {
    title: "SSH-Befehl",
    agent: "Agent",
    requestedBy: (member) => `Angefragt von ${member}`,
    forLead: (lead) => `für ${lead}`,
    host: "Host",
    hostKey: "Host-Schlüssel",
    showHostKey: "Ganzen Host-Schlüssel zeigen",
    timeout: (seconds) => `Zeitlimit: ${seconds} s`,
    hidden: "Enthält versteckte Zeichen. Sie werden als Codes gezeigt.",
    showAll: "Alles zeigen",
    showLess: "Weniger zeigen",
    expandFirst: "Zeige den ganzen Befehl, bevor du ihn erlaubst.",
    allowOnce: (host) => `Einmal erlauben auf ${host}`,
    deny: (host) => `Ablehnen auf ${host}`,
    expires: (time) => `Läuft ab: ${time}`,
    states: {
      awaiting_approval: "Wartet auf deine Entscheidung",
      executing: "Läuft …",
      completed: "Abgeschlossen",
      failed: "Fehlgeschlagen",
      declined: "Abgelehnt",
      expired: "Abgelaufen",
      cancelled: "Zugang geändert",
      unknown: "Ergebnis nach einem Neustart unbekannt",
    },
    removed: "Host entfernt",
    exit: (code) => `Exit-Code ${code}`,
    interactive: "Interaktive Shell · kein Exit-Code",
    timedOut: "Zeitlimit erreicht",
    truncated: "Ausgabe gekürzt",
    duration: (seconds) => `${seconds} s`,
  },
  note: {
    label: (host) => `SSH auf ${host}`,
    outcomes: {
      done: "fertig",
      exit: (code) => `Exit ${code}`,
      timedOut: "Zeitlimit erreicht",
      truncated: "gekürzt",
      revoked: "gestoppt",
    },
    status: {
      done: "Fertig",
      exit: (code) => `Exit ${code}`,
      timedOut: "Zeitlimit erreicht",
      truncated: "Ausgabe gekürzt",
      revoked: "Gestoppt",
      running: "Läuft",
    },
    results: {
      timedOut: "Der Befehl hat sein Zeitlimit erreicht und wurde gestoppt.",
      truncated: "Die Ausgabe war länger als das Limit und wurde abgeschnitten.",
      revoked: "Der Befehl wurde gestoppt, weil sich sein Zugang geändert hat.",
    },
    interactive:
      "Lief in der interaktiven Shell des Geräts, die keinen Exit-Code meldet. Prüfe die Ausgabe.",
    command: "Befehl",
    copy: "Befehl kopieren",
    exitCode: "Exit-Code",
    duration: "Dauer",
    seconds: (seconds) => `${seconds} s`,
    result: "Ergebnis",
    preview: "Von diesem Befehl wurde nur der Anfang gespeichert.",
    redacted: "Geheimnisse ausgeblendet",
    cut: "Von diesem Befehl werden nur die ersten 8 KB gezeigt.",
  },
  group: {
    label: "SSH-Aktivität",
    hosts: (count) => `${count} Hosts`,
  },
  plain: {
    title: "Direktes ssh",
    ready:
      "Direktes ssh funktioniert in der Shell dieses Agenten für seine vertrauten Hosts: ssh, scp, sftp, rsync, git und Tunnel.",
    readyNone: "Noch kein Host hat einen Alias: Nur vertraute Hosts bekommen einen.",
    noShell: "Direktes ssh braucht Shell-Zugriff für diesen Agenten.",
    noOpenSsh:
      "Direktes ssh braucht OpenSSH auf diesem Computer. SSH-Befehle über AgentPier funktionieren weiter.",
    tooOld:
      "Direktes ssh braucht OpenSSH 8.9 oder neuer auf diesem Computer. SSH-Befehle über AgentPier funktionieren weiter.",
    failed:
      "Direktes ssh konnte für diesen Agenten nicht gestartet werden. SSH-Befehle über AgentPier funktionieren weiter.",
    notEligible: "Direktes ssh ist für diesen Agenten nicht verfügbar.",
    approvalHint:
      "Hosts mit Freigabe haben keinen Alias: Jeder Befehl fragt weiter bei dir nach.",
    openConnections:
      "Wird ein Host entzogen oder auf Mit Freigabe gestellt, sind neue Verbindungen sofort gesperrt. Offene Verbindungen und Tunnel bleiben offen, bis sie enden.",
    aliasLabel: (alias) => `ssh ${alias}`,
    sshConfig: (reason) =>
      `AgentPier hat ~/.ssh/config nicht geändert: ${reason}. Meldet ssh <alias> in der Shell des Agenten einen unbekannten Host, nutze ssh -F "$AGENTPIER_SSH_CONFIG" <alias>.`,
    copy: "Befehl kopieren",
  },
  history: {
    title: (host) => `SSH auf ${host}`,
    trusted: "Vertrauter Lauf",
  },
};
