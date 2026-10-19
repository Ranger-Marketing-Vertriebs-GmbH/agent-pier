/** German browser-visible server messages, addressed through English semantic keys. */
export const notifications = Object.freeze({
  unavailable: "Benachrichtigungen sind nicht verfügbar.",
  deviceLabelTooLong: "Gerätenamen für Benachrichtigungen sind auf 80 Zeichen begrenzt.",
  deviceLimit: "Bitte zuerst ein altes Benachrichtigungsgerät entfernen.",
  deviceNotRegistered: "Das Benachrichtigungsgerät ist nicht mehr registriert.",
  deliveryFailed: "Zustellung fehlgeschlagen. Bitte eine Testbenachrichtigung senden.",
  deliveryFailedWithReason: (detail) =>
    `Zustellung fehlgeschlagen (${detail}). Bitte eine Testbenachrichtigung senden.`,
  refusedSignature: (code) =>
    `Der Push-Dienst hat die Absenderkennung abgelehnt (${code}). Bitte AgentPier aktualisieren und eine Testbenachrichtigung senden.`,
  refusedExpiredSignature: (code) =>
    `Der Push-Dienst hält die Absendersignatur für abgelaufen (${code}). Bitte die Systemzeit des Servers prüfen.`,
  refusedKey: (code) =>
    `Das Gerät wurde mit einem anderen Absenderschlüssel registriert (${code}). Bitte Benachrichtigungen auf diesem Gerät neu aktivieren.`,
  refusedRateLimit: (code) =>
    `Der Push-Dienst meldet zu viele Anfragen (${code}). Bitte später erneut versuchen.`,
  refusedPayload: (code) =>
    `Die Benachrichtigung ist für den Push-Dienst zu groß (${code}).`,
  refusedRequest: (code) =>
    `Der Push-Dienst hat die Anfrage als ungültig abgelehnt (${code}).`,
  refusedUnavailable: (code) =>
    `Der Push-Dienst ist vorübergehend nicht verfügbar (${code}). Bitte später erneut versuchen.`,
  notDelivered:
    "Die Benachrichtigung konnte nicht zugestellt werden. Bitte Berechtigung und Abonnement dieses Geräts prüfen.",
  invalidId: "Ungültige Benachrichtigungs-ID.",
  invalidSubscriptionKey: "Ungültiger Schlüssel des Push-Abonnements.",
  invalidSubscription: "Ungültiges Push-Abonnement.",
  invalidEndpoint: "Ungültiger Push-Endpunkt.",
  publicHttpsRequired: "Push erfordert einen öffentlichen HTTPS-Endpunkt.",
  invalidPublicKey: "Ungültiger öffentlicher Push-Schlüssel.",
  invalidPreferences: "Ungültige Einstellungen für Benachrichtigungen.",
  presenceRateLimit: "Zu viele Sichtbarkeitsmeldungen. Bitte kurz warten.",
});
