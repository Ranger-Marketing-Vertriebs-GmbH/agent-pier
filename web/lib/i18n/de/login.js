export const loginCopy = Object.freeze({
  title: "Anmelden",
  setup: "Benutzer erstellen",
  welcome: "Willkommen bei AgentPier",
  description: "Melde dich an, um deinen Arbeitsbereich zu öffnen.",
  setupDescription:
    "Lege deinen Benutzernamen und dein Passwort fest. Du bist der Besitzer dieses Arbeitsbereichs und kannst später weitere Benutzer anlegen.",
  setupElsewhere:
    "Dieser Arbeitsbereich hat noch keinen Besitzer. Er wird direkt auf dem AgentPier-Rechner oder über sein eigenes Tailscale-Konto eingerichtet; danach kannst du dich hier anmelden.",
  username: "Benutzername",
  password: "Passwort",
  repeat: "Passwort wiederholen",
  passwordHint: "Mindestens 12 Zeichen",
  mismatch: "Die Passwörter stimmen nicht überein.",
  loading: "Anmeldung wird geprüft …",
  pending: "Bitte warten …",
  retry: "Erneut versuchen",
  failed: "Anmeldung konnte nicht geprüft werden.",
  errors: {
    LOGIN_ALREADY_CONFIGURED:
      "Der Benutzer wurde bereits eingerichtet. Bitte melde dich an.",
    LOGIN_USERNAME_INVALID: "Gib einen Benutzernamen mit 1 bis 100 Zeichen ein.",
    LOGIN_USERNAME_TAKEN:
      "Diesen Benutzernamen trägt schon ein Benutzer. Wähle einen anderen.",
    LOGIN_PASSWORD_INVALID: "Das Passwort muss 12 bis 1024 Zeichen lang sein.",
    LOGIN_CREDENTIALS_INVALID: "Benutzername oder Passwort ist falsch.",
    LOGIN_THROTTLED: "Zu viele Anmeldeversuche. Bitte warte eine Minute.",
    LOGIN_REQUIRED: "Bitte melde dich an.",
    LOGIN_SETUP_LOCAL_ONLY:
      "Der Besitzer wird direkt auf dem AgentPier-Rechner oder über sein eigenes Tailscale-Konto eingerichtet.",
  },
  logout: "Abmelden",
});
