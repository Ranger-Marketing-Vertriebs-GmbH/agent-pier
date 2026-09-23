/** German browser-visible pipeline run messages, addressed through English semantic keys. */
export const pipelines = Object.freeze({
  invalidIdentifier: "Ungültige Pipeline-Kennung.",
  runNotFound: "Pipeline-Lauf nicht gefunden.",
  runChanged: "Der Pipeline-Lauf wurde geändert. Bitte neu laden und erneut versuchen.",
  engineClosed: "Die Pipeline-Ausführung ist beendet.",
  invalidPage: "Ungültige Pipeline-Seite.",
  invalidStatus: "Ungültiger Pipeline-Status.",
  invalidPageFilter: "Ungültige Pipeline-Seite",
  invalidStatusFilter: "Ungültiger Status-Filter",
  invalidProjectFilter: "Ungültiger Projekt-Filter",
  invalidStatusValue: "Ungültiger Pipeline-Status",
  artifactPathRequired: "Ein Artefaktpfad ist erforderlich",
  invalidVerificationStepFilter: "Ungültiger Prüfschritt",
  invalidEnabledFilter: "Ungültiger Aktiv-Filter",
  profileDisabledFilter: "Dieses Profil ist deaktiviert",
  activeRunsBlockDelete: "Eine Pipeline mit aktiven Läufen kann nicht gelöscht werden",
  workingDirectoryAndTaskRequired:
    "Ein Arbeitsverzeichnis und eine Aufgabe sind erforderlich.",
  stageCannotBeRetried: "Diese Stufe kann nicht wiederholt werden.",
  finishBeforePublishing:
    "Bitte den Lauf abschließen oder abbrechen, bevor sein Branch veröffentlicht wird.",
  cancelBeforeDeleting: "Bitte den Lauf vor dem Löschen abbrechen.",
  importedHistoryReadOnly:
    "Importierter Pipeline-Verlauf ist schreibgeschützt. Bitte einen neuen Lauf starten, um weiterzuarbeiten.",
  actionUnavailable: "Diese Aktion ist im aktuellen Pipeline-Zustand nicht verfügbar.",
  invalidUsageResetTime: "Ungültige Rücksetzzeit für das Nutzungslimit.",
  feedbackSize: "Rückmeldungen müssen zwischen 1 und 32768 Bytes enthalten.",
  invalidLoopFeedback: "Ungültige Rückmeldung für die Schleife.",
  operatorRepairRound: "Eine weitere Korrekturrunde wurde angefordert.",
  reconcileRequiresQuiescedTurn:
    "Der Abgleich erfordert einen erfolgreichen, zur Ruhe gekommenen nativen Turn.",
  noFreshVerdict: "Es liegt kein frisches gültiges Ergebnis zum Abgleichen vor.",
  overrideRequiresStoppedTurn:
    "Das Übersteuern erfordert einen gestoppten, zur Ruhe gekommenen nativen Turn.",
  runAlreadyFinished: "Der Pipeline-Lauf ist bereits abgeschlossen.",
  nodeNotFound: "Pipeline-Knoten nicht gefunden.",
  artifactNotDeclared: "Das Artefakt wurde von dieser Stufe nicht angegeben.",
  artifactPathPrivate: "Der Artefaktpfad ist privat.",
  artifactNotFound: "Artefakt nicht gefunden.",
  invalidVerificationStep: "Ungültiger Prüfschritt.",
  verificationLogNotFound: "Prüfprotokoll nicht gefunden.",
  invalidArtifactPath: "Ungültiger Artefaktpfad.",
  artifactSymlinksForbidden: "Symbolische Links sind als Artefakte nicht erlaubt.",
  artifactNotRegularFile: "Das Artefakt ist keine reguläre Datei.",
  verdictNotJson: "Das Ergebnis ist kein gültiges JSON.",
  verdictNotObject: "Das Ergebnis muss ein Objekt sein.",
  verdictResultAndSummary:
    "Das Ergebnis benötigt ein pass/fail-Resultat und eine Zusammenfassung.",
  verdictRequiresHumanBoolean: "requiresHuman im Ergebnis muss ein Boolean sein.",
  verdictFindingsArray: "Die Befunde im Ergebnis müssen ein Array sein.",
  verdictFindingTitle: "Ein Befund im Ergebnis benötigt einen Titel.",
  verdictTooLarge: "Das Ergebnis ist größer als 64 KiB.",
  verdictUnreadable: "Das Ergebnis konnte nicht sicher gelesen werden.",
  invalidTurn: "Ungültiger Pipeline-Turn.",
  unsafeVerdictDirectory: "Unsicheres Verzeichnis für Pipeline-Ergebnisse.",
  invalidVerificationReceipt: "Ungültige Prüfquittung.",
  unsafeVerificationDirectory: "Unsicheres Verzeichnis für den Prüfauftrag.",
  invalidVerificationPlan: "Ungültiger Prüfplan.",
  verificationJobExists: "Der Prüfauftrag existiert bereits.",
  verificationCancellationPending: "Der Abbruch der Prüfung steht noch aus.",
  invalidVerificationResult: "Ungültiges Prüfergebnis.",
  verificationConfigUnavailable: "Die Prüfkonfiguration konnte nicht geladen werden.",
  verificationNotStarted: "Die Prüfung konnte nicht gestartet werden.",
  verificationUntrustworthy:
    "Die Prüfung hat keine vertrauenswürdigen abgeschlossenen Ergebnisse geliefert.",
  verificationFailedThreeTimes:
    "Die Prüfung ist auch nach drei Versuchen fehlgeschlagen.",
  frozenAccountRequired: "Eine eingefrorene Account-Konfiguration ist erforderlich.",
  frozenConnectionRequired:
    "Eine eingefrorene Konfiguration der Provider-Verbindung ist erforderlich.",
  noNativeConversationToResume:
    "Der vorherige Turn hat keine geprüfte native Unterhaltung, die fortgesetzt werden kann.",
  invalidNativeConversation: "Ungültige Kennung der nativen Unterhaltung.",
  sessionOwnershipMismatch: "Die Zuordnung der Pipeline-Sitzung stimmt nicht überein.",
  invalidSessionMode: "Ungültiger Pipeline-Sitzungsmodus.",
  observationRequiresTurn:
    "Die native Beobachtung erfordert einen eigenen Pipeline-Turn.",
  useFeedbackControls:
    "Für diesen Turn ohne Terminal bitte die Rückmeldefunktionen der Pipeline verwenden.",
  invalidObservationFile: "Ungültige native Beobachtungsdatei.",
  observationEventTooLarge:
    "Ein natives Ereignis überschreitet das Beobachtungslimit von 16 MiB.",
  invalidNativeJsonl: "Das native CLI hat ungültiges JSONL ausgegeben.",
  stageWorkspaceUnsafe:
    "Der Arbeitsbereich der Stufe konnte nicht sicher vorbereitet werden.",
  stageLaunchFailed:
    "Die Stufe konnte nicht gestartet werden. Bitte Account und native Sitzung prüfen.",
  usageLimitReached: "Das Nutzungslimit des nativen Providers ist erreicht.",
  nativeTurnFailed:
    "Der native Turn der Stufe ist nicht erfolgreich beendet worden. Bitte die Terminalausgabe prüfen.",
  verdictMissing: "Die Stufe hat kein frisches Ergebnis geliefert.",
  pullRequestPublishFailed:
    "Der Branch des Laufs oder der Pull Request konnte nicht veröffentlicht werden. Bitte die PR-Aktion wiederholen.",
  pullRequestUpdateFailed:
    "Der Branch des vorhandenen Pull Requests konnte nicht aktualisiert werden. Der Arbeitsbereich bleibt erhalten.",
  operationInterrupted:
    "Der vorherige Vorgang wurde unterbrochen. Bitte vor einem neuen Versuch den erhaltenen Arbeitsbereich prüfen.",
  inactivityTimeout:
    "Die native Stufe hat ihr Inaktivitätsbudget von zwei Stunden überschritten.",
  turnNotRecovered:
    "Der genaue native Turn konnte nicht wiederhergestellt werden. Sein Arbeitsbereich bleibt erhalten.",
  checkpointFailed:
    "Die Änderungen der Stufe konnten nicht gesichert werden. Der Arbeitsbereich bleibt erhalten.",
});
