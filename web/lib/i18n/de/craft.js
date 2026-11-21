export const craftCopy = {
  title: "Craft Anything",
  description:
    "Craft Anything untersucht eine App, eine Website oder Screenshots davon und baut dir deine eigene Version. Jeder Nachbau bekommt ein eigenes Projekt.",
  loading: "Nachbauten werden geladen …",
  notInstalled:
    "Craft Anything ist nicht installiert. Installiere es, um Nachbauten zu starten.",
  openCraftAnything: "Craft Anything öffnen",
  // Other names the ⌘K search finds the page by.
  search: { craft: "Craft", rebuilds: "Nachbauten", rebuild: "Nachbau" },
  status: {
    starting: "Startet",
    building: "Baut",
    checking: "Prüft",
    needs_you: "Braucht dich",
    ready: "Fertig",
    paused: "Pausiert",
    failed: "Fehlgeschlagen",
  },
  steps: {
    label: "Schritte",
    study: "Untersuchen",
    build: "Bauen",
    check: "Prüfen",
    ready: "Fertig",
  },
  list: {
    title: "Deine Nachbauten",
    empty: "Noch keine Nachbauten. Starte unten einen.",
    // Without Craft Anything installed there is no start form below.
    none: "Noch keine Nachbauten.",
    sub: (step, time) => `${step} · aktualisiert ${time}`,
  },
  start: {
    title: "Nachbau starten",
    request: "Was soll entstehen?",
    requestPlaceholder: "Eine To-do-App wie das Ziel, mit dunklem Design",
    name: "Projektname",
    namePlaceholder: "notizen-klon",
    nameHint:
      "Der Ordner des neuen Projekts im Standard-Projektordner: wenige Wörter, aus der Beschreibung vorgeschlagen.",
    nameTooLong:
      "Kürze den Projektnamen auf wenige Wörter: höchstens 48 Zeichen und 6 Wörter.",
    nameRequired:
      "Gib dem Projekt einen kurzen Namen aus wenigen Wörtern (höchstens 48 Zeichen und 6 Wörter).",
    target: "Ziel",
    targetNone: "Keins",
    targetUrl: "Webadresse",
    targetPath: "Lokaler Pfad",
    targetPictures: "Screenshots",
    urlLabel: "Webadresse des Ziels",
    pathLabel: "Pfad des Ziels",
    stack: "Stack",
    account: "Claude-Account",
    mode: "Modus",
    cleanRoom: "Clean Room",
    deep: "Tief",
    modeHint:
      "Clean Room betrachtet das Ziel nur von außen. Tief darf auch hineinschauen und es zum Beispiel dekompilieren.",
    autoMode: "Automodus",
    autoModeHint:
      "Craft Anything entscheidet seine Rückfragen selbst und AgentPier erteilt seine Freigaben. Ausgeschaltet wartet jede Rückfrage und Freigabe auf dich.",
    rounds: "Runden",
    roundsHint:
      "Wie viele Bau- und Prüfrunden Craft Anything nutzen darf. Jede Runde, auch die letzte, endet damit, dass es verbessert, was seine Prüfungen gefunden haben.",
    consent:
      "Mit dem Start lässt du Craft Anything Claude mit dem gewählten Account ausführen und dessen Tokens verbrauchen. Baue nur Software nach, die dir gehört oder die du nachbauen darfst, und umgehe nie DRM, Logins oder Anti-Cheat-Systeme.",
    noAccounts:
      "Kein Claude-Account kann bauen. Füge unter CLIs & Erweiterungen › Accounts einen eigenen Claude-Account ohne Provider hinzu.",
    submit: "Nachbau starten",
    starting: "Wird gestartet …",
  },
  // The stack choices of the start form; the values stay Craft Anything's.
  stacks: {
    builderChoice: "Wahl des Builders",
    plainHtml: "Reines HTML und CSS",
    rustConsole: "Rust (Konsole)",
    unity: "Unity",
    unreal: "Unreal",
    godot: "Godot",
  },
  pictures: {
    list: "Screenshots",
    add: "Screenshots hinzufügen",
    choose: "Screenshots oder Fotos auswählen",
    hint: "Screenshots oder Fotos des Produkts. Craft Anything baut nach, was sie zeigen.",
    lookHint: "Optional: Screenshots oder Fotos des Aussehens, das du erwartest.",
    followUpHint:
      "Optional: Screenshots oder Fotos des gewünschten Aussehens. Sie kommen zu den Bildern des Originals.",
    required: "Füge mindestens einen Screenshot hinzu.",
    tooMany: (max) => `Ein Nachbau nimmt höchstens ${max} Screenshots.`,
    tooLarge: (name) => `„${name}“ ist größer als 20 MB.`,
    unsupported: (name) => `„${name}“ ist kein Bild im Format PNG, JPEG, WebP oder GIF.`,
    uploadFailed: (name, reason) =>
      `„${name}“ konnte nicht hochgeladen werden: ${reason}`,
  },
  defaults: {
    title: "Voreinstellungen",
    hint: "Was neue Nachbauten verwenden. Nachbauten, die deine Sessions und Agenten starten, verwenden immer diese.",
    save: "Voreinstellungen speichern",
    saving: "Wird gespeichert …",
    saved: "Voreinstellungen gespeichert. Neue Nachbauten starten damit.",
  },
  detail: {
    pausedNote: "Pausiert. Fortsetzen macht dort weiter, wo der Bau stehen blieb.",
    answeredElsewhere:
      "Diese Frage wurde schon an anderer Stelle beantwortet, in einem anderen Tab oder im Eingang.",
    // Auto mode switched on while questions already wait.
    autoModeWaiting:
      "Der Automodus entscheidet neue Fragen. Beantworte die schon wartenden Fragen hier.",
    checksPassed: (passed, total) => `${passed} von ${total} Prüfungen bestanden`,
    // Craft Anything reports no price (`priced: false`), e.g. on a subscription.
    costUnknown: "Kein Preis bekannt",
    request: "Auftrag",
    checkTitle: "Letzte Prüfung",
    noCheck: "Noch keine Prüfung.",
    checkPassed: (name) => `${name}: bestanden`,
    checkFailed: (name) => `${name}: nicht bestanden`,
    checkName: "Prüfung",
    similarity: (percent) => `${percent} % ähnlich zum Ziel`,
    questions: "Wartet auf dich",
    activity: "Aktivität",
    activityEmpty: "Noch keine Aktivität.",
    activityLoading: "Aktivität wird geladen …",
    notAnswering: (time) =>
      `Craft Anything antwortet seit ${time} nicht. Hier steht der letzte Stand, den es gemeldet hat.`,
    usage: "Verbrauch",
    tokens: (input, output) => `${input} Tokens rein · ${output} Tokens raus`,
    cost: (amount) => `Etwa ${amount}`,
    lastReply: "Letzte Antwort",
    pause: "Pausieren",
    pausing: "Wird pausiert …",
    continue: "Fortsetzen",
    continuing: "Wird fortgesetzt …",
    followUp: "Änderungen anfragen",
    followUpHint: "Startet eine weitere Runde im selben Projekt.",
    followUpSend: "Anfrage senden",
    sending: "Wird gesendet …",
    autoMode: "Automodus",
    openProject: "Projekt öffnen",
    openFolder: "Ordner öffnen",
    openSession: "Hier eine Session öffnen",
    gone: "Diesen Nachbau gibt es nicht mehr.",
    remove: "Aus der Liste entfernen",
    removeTitle: (name) => `Nachbau „${name}“ aus der Liste entfernen?`,
    removeBody:
      "AgentPier vergisst diesen Nachbau mit seinen offenen Rückfragen. Sein Ordner und sein Projekt bleiben, mit allem, was Craft Anything gebaut hat.",
  },
  source: {
    owner: "Von dir gestartet",
    session: "Von einer Session gestartet",
    agent: "Von einem Agenten gestartet",
  },
  question: {
    question: "Rückfrage",
    approval: "Freigabe",
    choicesLabel: "Antworten",
    textLabel: "Deine Antwort",
    send: "Antwort senden",
    action: "Was es tun würde",
    allow: "Erlauben",
    allowAlways: "Immer erlauben",
    deny: "Ablehnen",
    autoFailed:
      "Der Automodus konnte das nicht erlauben. Entscheide hier, ob es laufen darf.",
    sending: "Wird gesendet …",
  },
};
