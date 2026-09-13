export const cloneFormCopy = {
  repositoryCloneTitle: "Repository klonen",
  cloneDescription:
    "Öffentliche GitHub-Repositories benötigen kein Token. Mit einem Profil kannst du zugängliche Repositories durchsuchen. Das Repository erhält einen neuen Unterordner.",
  credentialLabel: "Token-Profil",
  repositoryFieldsOption: "Öffentlich auf github.com · ohne Token",
  repositoryUrlLabel: "Repository-URL oder owner/repo",
  repositoryUrlPlaceholder: "organisation/projekt",
  parentDirectoryLabel: "Übergeordneter Ordner",
  folderNameLabel: "Neuer Ordnername",
  folderNamePlaceholder: "mein-projekt",
};
export const credentialDialogCopy = {
  commitName: "Commit-Name (optional)",
  commitEmail: "Commit-E-Mail (optional)",
  commitIdentityHint:
    "Name und E-Mail für Commits in Sitzungen mit diesem Zugang. Beide Felder leer lassen, um vorhandene Git-Einstellungen zu verwenden. Bestehende Sitzungen nach Änderungen neu laden. Bei mehreren Hosts ohne Projektzuordnung wird keine Identität automatisch gewählt.",
  commitIdentityInvalid:
    "Bitte einen gültigen Commit-Namen und eine E-Mail-Adresse angeben oder beide Felder leeren.",
  repositoryDialogTitle: "Token löschen?",
  deleteCredentialPrefix: "Das Token-Profil „",
  deleteCredentialSuffix: "“ wird gelöscht. Deine lokalen Projekte bleiben erhalten.",
  multipleProfilesDescription:
    "Mehrere Profile pro Host sind möglich — für GitHub und GitHub Enterprise.",
  profileNamePlaceholder: "z. B. Persönlich oder Arbeit",
  enterpriseHostDescription:
    "HTTPS-Host ohne Repository-Pfad, bei Enterprise auch mit Port.",
  githubCliPortRestriction: "GitHub CLI unterstützt Hosts ohne Port.",
  repositoryAgentChoiceLabel: "Standard für Agenten auf diesem Host",
  firstCredentialDefaultDescription:
    "Der erste Zugang auf diesem Host ist automatisch der Standard.",
  formContentFieldLabel: "Access Token",
  savedTokenPlaceholder: "Gespeichert · zum Ersetzen eingeben",
  blankTokenPreservesSecret:
    "Token gespeichert. Ein leeres Feld behält das bisherige Token.",
  tokenPrivacyDescription:
    "Das Token wird lokal gespeichert und anschließend nicht angezeigt.",
};
export const credentialListCopy = {
  tokenSaved: "Token gespeichert",
  tokenMissing: "Kein Token gespeichert",
  repositoryAgentBadge: "Standard für Agenten",
  repositoryDetailsDescription: "GitHub CLI unterstützt Hosts ohne Port.",
  buttonAriaLabel: (value1) => `${value1} löschen`,
  repositoryEmpty:
    "Öffentliche GitHub-Repositories kannst du ohne Token klonen. Für private Repositories und die Suche füge ein Token hinzu.",
};
export const repositoriesPageCopy = {
  pageToplineLabel: "WORKSPACE / REPOSITORIES",
  subtle: "Lokal gespeichert",
  pageHeadingTitle: "Deine Repositories",
  pageHeadingDescription: "Vom Repository zur nächsten Sitzung.",
  repositoriesLoading: "Repositories werden geladen …",
  repositoryCredentialsTitle: "GitHub-Profile",
  savedCredentialsSuffix: " gespeichert",
  agentCredentialDescription:
    "Neue Agent-Sitzungen erhalten je Host den Standardzugang. Geklonte Projekte verwenden ihren gewählten Zugang.",
  repositoryProjectsTitle: "Lokale Projekte",
  projectCountSuffix: " Projekte",
  buttonAriaLabel: (value1) => `Sitzung in ${value1} starten`,
  launchProjectSession: "Sitzung starten ",
  repositoryEmpty:
    "Deine geklonten Repositories erscheinen hier. Starte anschließend eine CLI-Sitzung direkt im Projekt.",
};
export const repositoryPickerCopy = {
  organizationLabel: "Organisation",
  searchOrganizations: "Organisation suchen",
  repositoryPickerFiltersOption: "Alle zugänglichen Repositories",
  searchRepositories: "Repository suchen",
  repositoryPickerFiltersPlaceholder: "Name oder owner/repo",
  repositoryPickerFieldLabel: "Verfügbare Repositories",
  searchingRepositories: "Repositories werden gesucht …",
  chooseRepository: "Repository auswählen …",
  retrySearch: "Suche erneut versuchen",
  repositoriesLoading: "Zugängliche Repositories werden geladen …",
  repositoryResultsSummary: (value1, value2) =>
    `${value1} Repositories gefunden · Seite ${value2}`,
  noMatchingRepositories:
    "Keine passenden Repositories gefunden. Du kannst unten eine URL eingeben.",
  searchLimitDescription:
    "Die Suche umfasst die ersten 1.000 zugänglichen Repositories. Weitere Repositories kannst du direkt über ihre URL klonen.",
  previousRepositories: "Vorherige Repositories",
  nextRepositories: "Weitere Repositories",
};
export const cloneStoreCopy = {
  notice: (value1) => `„${value1}“ wurde geklont. Du kannst jetzt eine Sitzung starten.`,
};
