export const devicesCopy = {
  title: "Android-Geräte",
  intro:
    "Android-Telefone, die auf diesem Rechner in Googles Android Emulator laufen, damit Agenten und Sessions Apps und Websites darauf testen können. Ein laufendes Gerät braucht etwa 3 bis 6 GB Arbeitsspeicher.",
  loading: "Android-Geräte werden geladen …",
  featureSub: "Emulierte Android-Telefone für Agenten und Sessions.",
  featureStates: {
    installed: "Installiert",
    absent: "Nicht installiert",
    working: "Wird installiert",
    failed: "Fehlgeschlagen",
    unavailable: "Nicht verfügbar",
  },
  installation: {
    group: "Installation",
    label: "Android Emulator, Platform Tools und System-Image",
    description: (download, disk) =>
      `Wird von Google in das Datenverzeichnis von AgentPier geladen: ${download} Download, ${disk} auf der Festplatte. Außerhalb davon wird nichts installiert, und deine eigene Android-Einrichtung bleibt unberührt.`,
    states: {
      absent: "Nicht installiert",
      downloading: "Lädt herunter",
      unpacking: "Entpackt",
      checking: "Prüft",
      removing: "Wird deinstalliert",
      installed: "Installiert",
      failed: "Fehlgeschlagen",
      unavailable: "Nicht verfügbar",
    },
    components: {
      platformTools: "Platform Tools",
      emulator: "Emulator",
      image: "System-Image",
    },
    downloading: (component, received, total) =>
      `${component} wird heruntergeladen: ${received} von ${total}`,
    unpacking: (component) => `${component} wird entpackt`,
    checking: (component) => `${component} wird geprüft`,
    starting: "Download wird gestartet",
    removing: "Die Geräte und die Android-Komponenten werden gelöscht",
    updating:
      "Eine neuere Version wird installiert. Bis sie fertig ist, können keine Geräte starten.",
    versions: (emulator, platformTools, image) =>
      `Emulator ${emulator}, Platform Tools ${platformTools}, System-Image ${image}`,
    versionUnknown: "nicht installiert",
    updateFailed: (reason) =>
      `Die Aktualisierung auf die aktuellen Versionen ist fehlgeschlagen, die installierten Versionen bleiben in Gebrauch. ${reason}`,
    updatePending:
      "Diese AgentPier-Version nutzt neuere Komponenten. Aktualisiere sie hier, sonst werden sie beim nächsten Start von AgentPier aktualisiert, solange kein Gerät läuft.",
    requested:
      "Die Installation wurde vom Installer angefordert und beginnt mit dem nächsten Start von AgentPier. Du kannst sie auch hier starten.",
    install: "Installieren …",
    installHint: (download) => `Lädt nach deiner Bestätigung ${download} von Google.`,
    retry: "Erneut versuchen …",
    retryHint: "Setzt den Download dort fort, wo er stehen geblieben ist.",
    update: "Aktualisieren …",
    updateHint: "Installiert die Versionen, die diese AgentPier-Version nutzt.",
    cancel: "Installation abbrechen",
    cancelHint: "Was schon geladen ist, bleibt für den nächsten Versuch erhalten.",
    remove: "Deinstallieren …",
    removeHint: "Löscht die Android-Komponenten und alle Geräte.",
    removeBusyHint: "Stoppe zuerst alle Geräte.",
    waitHint: "Läuft gerade",
  },
  installDialog: {
    title: "Android-Geräte installieren?",
    body: (download, disk, host) =>
      `AgentPier lädt drei Komponenten von ${host} in sein Datenverzeichnis: ${download} Download, ${disk} auf der Festplatte. Ein begonnener Download wird nach einer Unterbrechung fortgesetzt.`,
    componentsLabel: "Was geladen wird",
    emulator: (version) => `Android Emulator ${version}`,
    platformTools: (version) => `Android SDK Platform-Tools ${version} (adb)`,
    image: (api, abi) =>
      `Google-APIs-System-Image für Android API ${api} (${abi}), ohne Play Store`,
    terms:
      "Google stellt diese Komponenten unter eigenen Bedingungen bereit. Mit der Installation akzeptierst du sie:",
    notRedistributed:
      "AgentPier gibt keine dieser Dateien weiter. Jedes weitere Gerät braucht etwa 4 GB auf der Festplatte.",
    confirm: "Akzeptieren und installieren",
  },
  removeDialog: {
    title: "Android-Geräte deinstallieren?",
    body: (count) =>
      count === 1
        ? "Das löscht die Android-Komponenten und dein 1 Gerät mit allem darauf: Apps, Anmeldungen und Dateien. Das lässt sich nicht rückgängig machen."
        : `Das löscht die Android-Komponenten und deine ${count} Geräte mit allem darauf: Apps, Anmeldungen und Dateien. Das lässt sich nicht rückgängig machen.`,
    bodyEmpty:
      "Das löscht die Android-Komponenten aus dem Datenverzeichnis. Es gibt keine Geräte.",
    confirm: "Deinstallieren",
  },
  list: {
    group: "Geräte",
    add: "+ Neues Gerät",
    summary: (total, maxDevices, running, maxRunning) =>
      `${total} von ${maxDevices} Geräten, ${running} von ${maxRunning} laufen`,
    empty: "Noch keine Geräte. Lege eines mit „Neues Gerät“ an.",
    emptyNotInstalled: "Installiere oben die Android-Komponenten, um Geräte anzulegen.",
    emptyUnavailable: "Auf diesem Rechner können keine Android-Geräte laufen.",
    states: {
      stopped: "Gestoppt",
      starting: "Startet",
      running: "Läuft",
      stopping: "Stoppt",
      failed: "Fehlgeschlagen",
      resetting: "Wird zurückgesetzt",
      deleting: "Wird gelöscht",
    },
    creatorOwner: "Von dir angelegt",
    creatorAgent: (name) => `Von Agent ${name} angelegt`,
    creatorSession: (name) => `Von Session ${name} angelegt`,
    creatorGone: "Ersteller existiert nicht mehr",
    assigned: (names) => `Zugewiesen an ${names}`,
    assignedMore: (names, more) => `Zugewiesen an ${names} und ${more} weitere`,
    assignedManage: (name) => `${name} (darf zurücksetzen und löschen)`,
    assignedNone: "Nicht zugewiesen",
    size: (size) => `${size} auf der Festplatte`,
    held: "Du hältst dieses Gerät",
    viewers: (count) => (count === 1 ? "1 offene Ansicht" : `${count} offene Ansichten`),
    imageOutdated:
      "Dieses Gerät nutzt ein früheres System-Image. Es startet weiterhin; beim Zurücksetzen wechselt es auf das aktuelle Image.",
    imageOutdatedBlocked:
      "Dieses Gerät nutzt ein früheres System-Image. Es startet weiterhin, lässt sich aber erst zurücksetzen, wenn die Installation oben aktuell ist.",
    start: "Starten",
    stop: "Stoppen",
    reset: "Zurücksetzen …",
    delete: "Löschen …",
    startNamed: (name) => `${name} starten`,
    stopNamed: (name) => `${name} stoppen`,
    resetNamed: (name) => `${name} zurücksetzen …`,
    deleteNamed: (name) => `${name} löschen …`,
    actionsLabel: (name) => `Aktionen für ${name}`,
    createBlocked: (maxDevices) =>
      `Das Limit von ${maxDevices} Geräten ist erreicht. Lösche ein Gerät oder erhöhe unten das Limit.`,
  },
  createDialog: {
    title: "Neues Gerät",
    name: "Name",
    nameHint:
      "1 bis 40 Zeichen. Das Gerät ist ein Telefon mit Android 16 und 720 × 1600 Pixeln und braucht nach dem ersten Start etwa 4 GB auf der Festplatte.",
    placeholder: "Testtelefon",
    submit: "Gerät anlegen",
  },
  resetDialog: {
    title: (name) => `Gerät „${name}“ zurücksetzen?`,
    body: "Das Gerät geht in den Werkszustand zurück: Alle Apps, Anmeldungen und Dateien darauf werden gelöscht. Sein Name bleibt, ebenso, wer es nutzen darf. Ein laufendes Gerät wird vorher gestoppt.",
    confirm: "Jetzt zurücksetzen",
  },
  deleteDialog: {
    title: (name) => `Gerät „${name}“ löschen?`,
    body: "Das Gerät und alles darauf werden gelöscht: Apps, Anmeldungen und Dateien. Ein laufendes Gerät wird vorher gestoppt. Das lässt sich nicht rückgängig machen.",
    confirm: "Jetzt löschen",
  },
  limits: {
    group: "Limits",
    maxDevices: "Geräte insgesamt",
    maxDevicesSub: "1 bis 20. Jedes Gerät belegt etwa 4 GB auf der Festplatte.",
    maxRunning: "Gleichzeitig laufende Geräte",
    maxRunningSub:
      "1 bis 5. Jedes laufende Gerät braucht etwa 3 bis 6 GB Arbeitsspeicher. Ist das Limit erreicht, stoppt der Start eines weiteren Geräts das am längsten ungenutzte.",
    idle: "Ein laufendes Gerät stoppt nach 15 Minuten ohne Nutzung von selbst, und alle Geräte stoppen, wenn AgentPier stoppt.",
    invalid: "Gib 1 bis 20 Geräte insgesamt und 1 bis 5 gleichzeitig laufende Geräte an.",
    save: "Limits speichern",
  },
  codes: {
    DEVICE_NOT_FOUND: "Dieses Gerät gibt es nicht mehr.",
    DEVICE_NAME_INVALID: "Gib einen Namen mit 1 bis 40 Zeichen ein.",
    DEVICE_NAME_TAKEN: "Ein anderes Gerät hat diesen Namen schon. Wähle einen anderen.",
    DEVICE_LIMIT_TOTAL:
      "Das Limit der Geräte insgesamt ist erreicht. Lösche ein Gerät oder erhöhe das Limit.",
    DEVICE_LIMIT_RUNNING:
      "Das Limit gleichzeitig laufender Geräte ist erreicht, und jedes laufende Gerät wird gerade genutzt. Stoppe ein Gerät oder erhöhe das Limit.",
    DEVICE_UNAVAILABLE:
      "Android-Geräte sind gerade nicht verfügbar. Prüfe oben die Installation.",
    DEVICE_IMAGE_MISSING:
      "Das dafür nötige System-Image ist nicht installiert. Aktualisiere oben die Installation und versuche es dann erneut.",
    DEVICE_DISK_SPACE:
      "Für ein weiteres Gerät ist zu wenig Speicherplatz frei. Gib Speicherplatz frei oder lösche ein Gerät.",
    DEVICE_BUSY:
      "Das Gerät ist mit einem anderen Vorgang beschäftigt. Versuche es gleich noch einmal.",
    DEVICE_STOP_FAILED:
      "Das Gerät hat nicht gestoppt. Stoppe es erneut; bleibt es dabei, starte AgentPier neu, das beendet, was davon übrig ist.",
    DEVICE_ADB_FAILED:
      "AgentPier hat das Gerät über adb nicht erreicht. Stoppe das Gerät und starte es neu.",
    DEVICE_ADB_PORT_IN_USE:
      "Den adb-Port von AgentPier (47600 auf diesem Rechner) belegt ein anderes Programm, zum Beispiel ein zweites AgentPier. Beende es und starte das Gerät dann erneut.",
    DEVICE_ADB_TIMEOUT:
      "Das Gerät hat nicht rechtzeitig geantwortet. Stoppe das Gerät und starte es neu.",
    DEVICE_ADB_CANCELLED: "Der Aufruf an das Gerät wurde abgebrochen.",
    DEVICE_BOOT_TIMEOUT:
      "Das Gerät ist nicht innerhalb von 3 Minuten hochgefahren. Starte es erneut; schlägt es weiter fehl, setze es zurück.",
    DEVICE_EXITED:
      "Der Emulator wurde unerwartet beendet. Starte das Gerät erneut; schlägt es weiter fehl, setze es zurück.",
    DEVICE_PORTS_BUSY:
      "Die Ports von AgentPier für Geräte (47600 bis 47621 auf diesem Rechner) belegt ein anderes Programm. Beende es und starte das Gerät dann erneut.",
    DEVICE_START_FAILED:
      "Das Gerät ließ sich nicht starten. Starte es erneut; schlägt es weiter fehl, starte AgentPier neu.",
    DEVICE_START_CANCELLED: "Der Start wurde abgebrochen.",
    DEVICE_FORBIDDEN:
      "Dieses Gerät darf von hier aus nicht genutzt oder geändert werden.",
    DEVICE_HELD: "Du hältst dieses Gerät, deshalb kann es gerade nichts anderes nutzen.",
    DEVICE_NOT_RUNNING: "Das Gerät läuft nicht. Starte es zuerst.",
    DEVICE_CREATE_FORBIDDEN:
      "Diese Session darf keine Geräte anlegen. Erlaube es bei den Geräten der Session.",
    DEVICE_SESSION_INELIGIBLE:
      "Geräte bekommen nur deine eigenen laufenden Coding-Sessions, keine Anmelde-, Pipeline- oder importierten Sessions und keine Sessions des Agenten eines eingeschränkten Nutzers.",
    DEVICE_AGENT_INELIGIBLE:
      "Geräte bekommen nur deine eigenen Agenten, kein archivierter Agent, kein Agent eingeschränkter Nutzer und kein Agent mit eigenem Telegram-Bot für andere Personen.",
    DEVICE_RUN_FORBIDDEN:
      "Der Agent bekommt in diesem Lauf kein Gerät, weil er Inhalte verarbeitet, die nicht von dir stammen, oder weil die Herkunft des Laufs unbekannt ist.",
    DEVICE_OWNER_TURN_REQUIRED:
      "Ein Agent legt Geräte nur in einem Turn an, setzt sie nur dort zurück und löscht sie nur dort, den du mit einer eigenen Nachricht gestartet hast.",
    DEVICE_PULL_READONLY:
      "Dieser Lauf darf im Workspace des Agenten keine Dateien ändern, deshalb wurde keine Datei vom Gerät kopiert.",
    DEVICE_PASS_INVALID:
      "Ein Agent kann an ein Teammitglied nur Geräte weitergeben, die er selbst hat.",
    DEVICE_ASSIGNMENT_INVALID:
      "Diese Zuweisung ist nicht gültig. Vielleicht gibt es ein Gerät darin nicht mehr; lade neu und versuche es erneut.",
    DEVICE_INPUT_INVALID:
      "Beim Aufruf des Geräts fehlte eine Angabe oder sie hatte die falsche Form.",
    DEVICE_TEXT_UNSUPPORTED:
      "Auf einem Gerät lassen sich in dieser Version nur einfache ASCII-Zeichen tippen, keine Umlaute, Akzente oder Emoji.",
    DEVICE_ELEMENT_STALE:
      "Die Elementnummer stammt aus einer Übersicht des Bildschirms, die nicht mehr aktuell ist.",
    DEVICE_PATH_OUTSIDE:
      "Die Datei liegt außerhalb des Arbeitsordners der Session und wurde deshalb weder gelesen noch geschrieben.",
    DEVICE_PULL_SANDBOXED:
      "Eine Session in der Sandbox kann keine Dateien von einem Gerät in ihren Arbeitsordner kopieren, weil ihre Sandbox ihr dort vielleicht nur das Lesen erlaubt.",
    DEVICE_FILE_NOT_FOUND: "Unter diesem Pfad gibt es keine reguläre Datei.",
    DEVICE_FILE_TOO_LARGE:
      "Die Datei ist zu groß: Bis zu 200 MB gehen auf ein Gerät und bis zu 50 MB kommen von ihm.",
    DEVICE_COMMAND_FAILED: "Das Gerät hat die Aktion abgelehnt.",
    DEVICE_SCREEN_UNAVAILABLE:
      "Das Gerät hat seinen Bildschirm nicht geliefert. Versuche es gleich noch einmal.",
    DEVICE_CALL_TIMEOUT:
      "Der Aufruf des Geräts hat zu lange gedauert und wurde beendet. Ein Gerät, das noch startete, fährt weiter hoch.",
    DEVICE_SOURCE:
      "Dieses Gerät wurde mit einer neueren AgentPier-Version angelegt und kann hier nicht laufen.",
    DEVICES_SETTINGS_INVALID:
      "Gib 1 bis 20 Geräte insgesamt und 1 bis 5 gleichzeitig laufende Geräte an.",
    DEVICES_TERMS_REQUIRED:
      "Akzeptiere Googles Bedingungen, um die Komponenten zu installieren.",
    DEVICES_PLATFORM_UNSUPPORTED:
      "Googles Android Emulator läuft nur auf macOS mit Apple Silicon und auf Linux x64, deshalb können auf diesem Rechner keine Android-Geräte laufen.",
    DEVICES_KVM_MISSING:
      "Dieser Rechner hat kein /dev/kvm. Der Emulator braucht Hardware-Virtualisierung: Schalte sie in der Firmware ein, oder die verschachtelte Virtualisierung, falls dies eine virtuelle Maschine ist.",
    DEVICES_KVM_DENIED:
      "AgentPier darf /dev/kvm nicht öffnen. Nimm das Linux-Konto, unter dem AgentPier läuft, in die Gruppe kvm auf (sudo usermod -aG kvm <Name>), melde dieses Konto neu an und starte AgentPier neu.",
    DEVICES_NOT_INSTALLED: "Die Android-Komponenten sind nicht installiert.",
    DEVICES_OPERATION_RUNNING:
      "Die Android-Komponenten werden gerade installiert, aktualisiert oder entfernt. Warte, bis das fertig ist.",
    DEVICES_IN_USE:
      "Ein Gerät startet, läuft oder stoppt gerade. Stoppe zuerst alle Geräte.",
    DEVICES_SHUTTING_DOWN:
      "AgentPier wird gerade beendet. Versuche es nach dem Start erneut.",
    DEVICES_DOWNLOAD_FAILED:
      "Der Download von Google ist fehlgeschlagen. Prüfe die Internetverbindung und versuche es erneut; der Download wird dort fortgesetzt, wo er stehen geblieben ist.",
    DEVICES_DOWNLOAD_STALLED:
      "Der Download von Google kam nicht mehr voran. Versuche es erneut; er wird dort fortgesetzt, wo er stehen geblieben ist.",
    DEVICES_DOWNLOAD_CANCELLED: "Die Installation wurde abgebrochen.",
    DEVICES_CHECKSUM_MISMATCH:
      "Eine geladene Datei passte nicht zu ihrer erwarteten Prüfsumme und wurde verworfen. Versuche es erneut.",
    DEVICES_ARCHIVE_INVALID:
      "Ein geladenes Archiv ließ sich nicht wie erwartet entpacken. Versuche es erneut.",
    DEVICES_DISK_SPACE:
      "Für die Android-Komponenten ist zu wenig Speicherplatz frei. Gib Speicherplatz frei und versuche es dann erneut.",
    DEVICES_SDK_UNUSABLE:
      "Der geladene Emulator startet auf diesem Rechner nicht. Unter Linux braucht er die Bibliotheken libX11 und libX11-xcb (Debian und Ubuntu: sudo apt-get install libx11-6 libx11-xcb1). Versuche es danach erneut.",
    DEVICES_INSTALL_FAILED:
      "Die Installation oder das Entfernen ist fehlgeschlagen. Versuche es erneut; schlägt es weiter fehl, prüfe den freien Speicherplatz und das Server-Protokoll.",
    DEVICES_INTERRUPTED:
      "AgentPier wurde während der Installation beendet. Versuche es erneut; der Download wird dort fortgesetzt, wo er stehen geblieben ist.",
  },
  sdkMissingLibraries: (libraries) =>
    `Der geladene Emulator startet auf diesem Rechner nicht, weil diese Systembibliotheken fehlen: ${libraries}. Installiere die Pakete, die sie enthalten (unter Debian und Ubuntu enthält libx11-6 die libX11.so.6 und libx11-xcb1 die libX11-xcb.so.1), und versuche es dann erneut.`,
  unknownCode: (code) => `Etwas ist schiefgegangen (${code}).`,
  // Die Android-Geräte einer Coding-Session: der Dialog der Session und die Auswahl
  // im Dialog für eine neue Session.
  access: {
    title: "Android-Geräte",
    summary: "Wähle die Android-Geräte, die diese Session nutzen darf.",
    hint: "Die Session bedient ein zugewiesenes Gerät mit ihren Geräte-Tools: Sie startet und stoppt es, sieht und tippt auf seinen Bildschirm, installiert Apps und führt Befehle darauf aus. Ein Gerät erreicht das Netzwerk und die lokalen Dienste dieses Rechners; ein Gerät zuzuweisen ist deshalb ein Vertrauensschritt wie eine Shell zuzuweisen.",
    scope:
      "Zuweisungen bleiben, solange es die Session gibt, auch über einen Stopp und ein Neuladen. Ein Gerät, das die Session angelegt hat, gehört ihr: Sie darf es immer nutzen, zurücksetzen und löschen.",
    grantType: "Android-Gerät",
    listLabel: "Android-Geräte",
    empty:
      "Noch keine Geräte. Lege eines unter Einstellungen › Allgemein › Android-Geräte an.",
    busy: "Wird gespeichert …",
    saved: "Gespeichert.",
    own: "von dieser Session angelegt",
    permissions: "Berechtigungen",
    manage: (name) => `„${name}“ zurücksetzen und löschen`,
    create: "Geräte anlegen",
    createSub:
      "Geräte, die die Session anlegt, gehören ihr und zählen zum Limit der Geräte insgesamt.",
    tools: {
      ready: "Hat die Geräte-Tools",
      missing:
        "Diese Session läuft ohne AgentPier-Tools. Die Zuweisung ist gespeichert, aber die Session bekommt die Geräte-Tools erst nach einem Neuladen mit AgentPier-Tools; eine ohne sie gestartete Session braucht eine neue Session.",
    },
    launch: {
      hint: "Die Session darf die hinzugefügten Geräte mit ihren Geräte-Tools bedienen. Später änderst du das in der Session unter Android-Geräte.",
      summary: (count) => `${count} ${count === 1 ? "Android-Gerät" : "Android-Geräte"}`,
      summaryCreate: "darf Geräte anlegen",
      toolsOff:
        "Ohne AgentPier-Tools bekommt die Session keine Geräte-Tools. Schalte oben die AgentPier-Tools ein.",
    },
  },
  search: {
    newDevice: "Neues Gerät",
    sessionDevices: "Android-Geräte",
  },
};
