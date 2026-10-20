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
  verdictResponsesArray: "Die Antworten auf Befunde im Ergebnis müssen ein Array sein.",
  verdictResponseFinding: "Eine Antwort im Ergebnis benötigt die Kennung ihres Befunds.",
  verdictResponseStatus:
    "Eine Antwort im Ergebnis braucht den Status fixed, not-fixed oder disputed.",
  verdictResponseReason:
    "Eine Antwort mit not-fixed oder disputed braucht eine Begründung.",
  verdictCriteriaArray: "Die Akzeptanzkriterien im Ergebnis müssen ein Array sein.",
  verdictCriterionId:
    "Ein Eintrag zu einem Akzeptanzkriterium benötigt dessen Kennung, z. B. AC1.",
  verdictCriterionStatus:
    "Ein Eintrag zu einem Akzeptanzkriterium braucht den Status met oder not-met.",
  verdictCriterionEvidence:
    "Ein Eintrag zu einem Akzeptanzkriterium braucht einen Nachweis (evidence).",
  specSingle: "Ein Ergebnis darf nur eine Datei mit der Rolle spec angeben.",
  specOutsideReports:
    "Die Spec muss im Berichtsverzeichnis dieser Stufe liegen und als Artefakt mit der Rolle spec angegeben sein.",
  specMissing: "Die als spec angegebene Datei wurde nicht gefunden.",
  specUnreadable: "Die als spec angegebene Datei konnte nicht sicher gelesen werden.",
  specTooLarge: "Die Spec ist größer als 64 KiB.",
  specNoCriteria:
    "Die Spec braucht einen Abschnitt „## Acceptance criteria“ mit einer nummerierten Liste von Kriterien.",
  specText: "Die Spec muss Text zwischen 1 und 65536 Bytes enthalten.",
  specRedeclare:
    "Die Spec-Datei wurde geändert, aber nicht neu angegeben. Schreibe die vollständige Spec als spec.md in das Berichtsverzeichnis dieses Turns und gib sie mit der Rolle spec an.",
  specRevisionNotFound: "Diese Spec-Fassung wurde nicht gefunden.",
  specRevisionImported:
    "Ein importierter Lauf enthält nur den Text der aktuellen Spec; frühere Fassungen sind nicht verfügbar.",
  specFileUnsafe: "Die Spec-Datei im Arbeitsbaum kann nicht sicher geschrieben werden.",
  verdictTooLarge: "Das Ergebnis ist größer als 64 KiB.",
  verdictUnreadable: "Das Ergebnis konnte nicht sicher gelesen werden.",
  invalidTurn: "Ungültiger Pipeline-Turn.",
  unsafeVerdictDirectory: "Unsicheres Verzeichnis für Pipeline-Ergebnisse.",
  unsafeReportDirectory: "Unsicheres Verzeichnis für Pipeline-Berichte.",
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
    "Eine eingefrorene Konfiguration des Provider-Zugangs ist erforderlich.",
  noNativeConversationToResume:
    "Der vorherige Turn hat keine geprüfte native Unterhaltung, die fortgesetzt werden kann.",
  invalidNativeConversation: "Ungültige Kennung der nativen Unterhaltung.",
  sessionOwnershipMismatch: "Die Zuordnung der Pipeline-Session stimmt nicht überein.",
  invalidSessionMode: "Ungültiger Pipeline-Session-Modus.",
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
    "Die Stufe konnte nicht gestartet werden. Bitte Account und native Session prüfen.",
  portRangeExhausted:
    "Kein freier Portblock für die Stufe. Bitte laufende Stufen beenden oder pipelines.portRangeStart und portRangeEnd in config.json erweitern.",
  membersBlocked:
    "Mindestens ein Mitglied der parallelen Gruppe braucht eine Entscheidung, bevor die Gruppe abschließt.",
  groupChangedFiles:
    "Ein Mitglied der parallelen Gruppe hat das Arbeitsverzeichnis geändert. Prüfe die Änderungen, bevor die Gruppe abschließt.",
  groupVerificationFailed:
    "Die Prüfung ist fehlgeschlagen. Eine parallele Gruppe begutachtet nur und repariert nichts.",
  usageLimitReached: "Das Nutzungslimit des nativen Providers ist erreicht.",
  nativeTurnFailed:
    "Der native Turn der Stufe ist nicht erfolgreich beendet worden. Bitte die Terminalausgabe prüfen.",
  // Das Argument ist native CLI-Ausgabe und bleibt in ihrer Originalsprache.
  nativeTurnFailedWith: (error) =>
    `Der native Turn der Stufe ist nicht erfolgreich beendet worden: ${error}`,
  verdictMissing: "Die Stufe hat kein frisches Ergebnis geliefert.",
  pullRequestPublishFailed:
    "Der Branch des Laufs oder der Pull Request konnte nicht veröffentlicht werden. Bitte die PR-Aktion wiederholen.",
  pullRequestUpdateFailed:
    "Der Branch des vorhandenen Pull Requests konnte nicht aktualisiert werden. Der Arbeitsbereich bleibt erhalten.",
  operationInterrupted:
    "Der vorherige Vorgang wurde unterbrochen. Bitte vor einem neuen Versuch den erhaltenen Arbeitsbereich prüfen.",
  inactivityTimeout:
    "Der native Turn hat innerhalb seines Inaktivitätslimits keine Ausgabe erzeugt und wurde beendet.",
  turnTimeout:
    "Der native Turn hat seine maximale Laufzeit überschritten und wurde beendet.",
  verificationStepFailed: (step, exitCode) =>
    `Prüfschritt „${step}“ ist mit Exit-Code ${exitCode} fehlgeschlagen.`,
  verificationStepTimedOut: (step) =>
    `Prüfschritt „${step}“ hat das Zeitlimit überschritten.`,
  turnNotRecovered:
    "Der genaue native Turn konnte nicht wiederhergestellt werden. Sein Arbeitsbereich bleibt erhalten.",
  checkpointFailed:
    "Die Änderungen der Stufe konnten nicht gesichert werden. Der Arbeitsbereich bleibt erhalten.",
  riskTooManyChanges:
    "Der Lauf ändert zu viele Dateien, um sie mit den Risikoregeln abzugleichen.",
  riskCheckFailed:
    "Die geänderten Pfade konnten nicht mit den Risikoregeln des Projekts abgeglichen werden. Eine Freigabe setzt den Lauf ohne diese Prüfung fort.",
  unsafeStorage: "Unsicherer Pipeline-Speicher.",
  unsafeDatabase: "Unsichere Pipeline-Datenbank.",
});
