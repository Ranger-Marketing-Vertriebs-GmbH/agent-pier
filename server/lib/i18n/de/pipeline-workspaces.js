/** German browser-visible pipeline workspace messages, addressed through English semantic keys. */
export const pipelineWorkspaces = Object.freeze({
  projectMismatch:
    "Der vorbereitete Arbeitsbereich passt nicht zum freigegebenen Projekt. Es wurde keine native Stufe gestartet.",
  preparationFailed:
    "Der Pipeline-Arbeitsbereich konnte nicht sicher vorbereitet werden. Vorhandene Dateien bleiben erhalten.",
  githubCredentialsUnavailable:
    "Für diesen Vorgang sind keine GitHub-Zugangsdaten verfügbar.",
  githubRemoteRequired: "Pull Requests erfordern ein GitHub-Repository als Remote.",
  canonicalGithubRemoteRequired:
    "Pull Requests erfordern ein kanonisches GitHub-Repository als Remote.",
  githubCliRequired:
    "Bitte vor dem Erstellen eines Pull Requests das GitHub CLI installieren.",
  pullRequestOperationFailed: "GitHub konnte den Pull-Request-Vorgang nicht abschließen.",
  invalidPullRequestResponse: "GitHub hat eine ungültige Pull-Request-Antwort geliefert.",
  invalidPullRequestUrl: "GitHub hat eine ungültige Pull-Request-URL geliefert.",
  gitOperationFailed:
    "Der Git-Vorgang ist fehlgeschlagen. Bitte Repository, Branch und Zugangsdaten prüfen.",
  invalidGitReference: "Ungültige Git-Referenz.",
  gitReferenceNotCommit: "Die Git-Referenz ist kein Commit.",
  ownershipMismatch: "Die Zuordnung des Arbeitsbereichs stimmt nicht überein.",
  worktreeDirectoryUnsafe: "Das eigene Worktree-Verzeichnis ist unsicher.",
  worktreeExists: "Der Worktree des Laufs existiert bereits.",
  preparationUnrecoverable:
    "Die unterbrochene Vorbereitung des Worktrees kann nicht sicher fortgesetzt werden.",
  sourceIdentityChanged:
    "Die Identität des Quell-Repositorys hat sich während der Vorbereitung geändert.",
  preparationIntentMismatch:
    "Der unterbrochene Worktree entspricht nicht mehr der geplanten Vorbereitung.",
  gitExcludeUnsafe: "Die Git-Ausschlussdatei ist unsicher.",
  ownershipPathChanged: "Der Pfad des zugeordneten Arbeitsbereichs hat sich geändert.",
  ownershipIdentityChanged:
    "Die Identität des zugeordneten Arbeitsbereichs hat sich geändert.",
  gitOwnershipChanged: "Die Git-Zuordnung des Arbeitsbereichs hat sich geändert.",
  branchSwitched: "Der Worktree des Laufs wurde auf einen anderen Branch umgestellt.",
  processesStillRunning:
    "Bitte warten, bis die zugehörigen nativen Pipeline-Prozesse beendet sind, bevor aufgeräumt wird.",
  uncommittedChanges:
    "Der Worktree enthält nicht committete Änderungen; bitte vor dem Aufräumen sichern oder committen.",
  unpublishedCommits:
    "Der Worktree enthält unveröffentlichte Commits; bitte vor dem Aufräumen pushen.",
});
