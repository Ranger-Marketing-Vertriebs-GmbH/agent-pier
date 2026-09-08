export const chatUploadsCopy = Object.freeze({
  pendingMessage: "Es gibt noch offene Datei-Uploads. Bitte abschließen oder entfernen.",
  interrupted: "Upload unterbrochen. Bitte erneut versuchen.",
  storageFailed: "Datei konnte nicht für die Wiederherstellung gespeichert werden.",
  retry: (name) => `Erneut hochladen: ${name}`,
  retryButton: "Erneut versuchen",
  progress: (percent) => `Wird hochgeladen · ${percent} %`,
  waiting: "Wartet auf Upload",
  finishing: "Upload übertragen · wird gespeichert",
});
