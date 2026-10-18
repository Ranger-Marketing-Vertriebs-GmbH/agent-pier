export const cloneFormCopy = {
  cloneDescription:
    "Öffentliche GitHub-Repositories benötigen kein Token. Mit einem Profil kannst du zugängliche Repositories durchsuchen. Das Repository erhält einen neuen Unterordner.",
  credentialLabel: "Token-Profil",
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
    "Name und E-Mail für Commits in Sessions mit diesem Zugang. Beide Felder leer lassen, um vorhandene Git-Einstellungen zu verwenden. Bestehende Sessions nach Änderungen neu laden. Bei mehreren Hosts ohne Projektzuordnung wird keine Identität automatisch gewählt.",
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
  columnAccess: "Zugang",
  columnToken: "Token",
  columnCommitIdentity: "Commit-Identität",
};
export const githubAccessPageCopy = {
  pageHeadingTitle: "GitHub-Zugänge",
  loading: "GitHub-Zugänge werden geladen …",
};
export const repositoriesPageCopy = {
  agentCredentialDescription:
    "Neue Agent-Sessions erhalten je Host den Standardzugang. Geklonte Projekte verwenden ihren gewählten Zugang.",
  buttonAriaLabel: (value1) => `Session in ${value1} starten`,
  repositoryEmpty:
    "Deine geklonten Repositories erscheinen hier. Starte anschließend eine CLI-Session direkt im Projekt.",
};
export const repositoryPickerCopy = {
  organizationLabel: "Organisation",
  searchOrganizations: "Organisation suchen",
  repositoryPickerFiltersOption: "Alle zugänglichen Repositories",
  searchRepositories: "Repository suchen",
  repositoryPickerFieldLabel: "Verfügbare Repositories",
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
  notice: (value1) => `„${value1}“ wurde geklont. Du kannst jetzt eine Session starten.`,
};
export const tokenCheckCopy = {
  check: "Prüfen",
  checking: "Wird geprüft …",
  checkAriaLabel: (name) => `Token von ${name} prüfen`,
  notChecked: "Noch nicht geprüft",
  states: {
    valid: "Token gültig",
    expiring: "Token läuft bald ab",
    expired: "Token abgelaufen",
    invalid: "Token abgelehnt",
    error: "Prüfung fehlgeschlagen",
  },
  errors: {
    unauthorized: "GitHub hat den Token abgelehnt. Speichere einen neuen Token.",
    tokenMissing: "Für dieses Profil ist kein Token gespeichert.",
    forbidden: "GitHub hat den Zugriff auf den Benutzer-Endpunkt verweigert.",
    rateLimited: "Das Anfragelimit von GitHub ist erreicht. Versuche es später erneut.",
    unreachable: "Der GitHub-Host war nicht erreichbar.",
    unexpected: "GitHub hat unerwartet geantwortet.",
  },
  login: (login) => `Angemeldet als ${login}`,
  tokenTypes: {
    classic: "Klassischer Token",
    "fine-grained": "Fine-grained Token",
    oauth: "OAuth-Token",
    app: "GitHub-App-Token",
    unknown: "Token-Typ unbekannt",
  },
  scopes: (scopes) => `Scopes: ${scopes}`,
  noScopes: "Scopes: keine",
  fineGrainedPermissions: "Berechtigungen werden auf GitHub pro Repository festgelegt.",
  expires: (date) => `Läuft ab am ${date}`,
  noExpiry: "Kein Ablaufdatum",
  ssoRequired: (organization) =>
    `Die Organisation ${organization} verlangt für diesen Token eine SAML-SSO-Freigabe.`,
  ssoAuthorize: "Auf GitHub freigeben",
  checkedAt: (time) => `Geprüft ${time}`,
};
export const sessionGithubCopy = {
  label: "GitHub",
  none: "Kein GitHub-Profil",
  profile: (name, host) => `${name} (${host})`,
  removed: (host) => `${host}: Profil entfernt`,
  tokenProblem: (host) =>
    `${host}: Token unter Einstellungen › Zugriff › GitHub-Zugänge prüfen`,
  sshRemote:
    "Das Projekt-Remote verwendet SSH. GitHub-Tokens gelten nur für HTTPS; Git nutzt hier deine SSH-Schlüssel.",
};
