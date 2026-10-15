export const mcpPackages = {
  invalid:
    "Bitte ein Paket aus npm oder PyPI mit gültigem Namen und exakter Version angeben.",
  notFound: "Dieses Paket gibt es in der gewählten Registry nicht.",
  versionNotFound: "Diese Version des Pakets gibt es nicht.",
  registryUnavailable:
    "Die Registry ist gerade nicht erreichbar. Bitte später erneut versuchen.",
  needsScripts:
    "Das Paket braucht Installationsskripte oder einen Build aus dem Quellcode. Erlaube das ausdrücklich, um es zu installieren.",
  integrityMismatch: "Die Prüfsumme eines Pakets stimmt nicht mit der Registry überein.",
  foreignSource:
    "Eine Abhängigkeit stammt nicht aus der öffentlichen Registry und wird abgelehnt.",
  versionYanked:
    "Die Maintainer haben diese Version zurückgezogen (yanked). Bitte eine andere Version wählen.",
  noProgram: "Das Paket enthält kein startbares Programm.",
  programRequired: "Das Paket enthält mehrere Programme. Bitte eines auswählen.",
  toolchainUnavailable:
    "Die Toolchain für dieses Paket lässt sich auf diesem Rechner nicht bereitstellen (nur macOS und Linux mit glibc, arm64 oder x64).",
  downloadFailed: "Der Download ist fehlgeschlagen. Bitte später erneut versuchen.",
  installFailed: "Die Installation ist fehlgeschlagen. Details stehen im Protokoll.",
  previewExpired: "Die Vorschau ist abgelaufen. Bitte die Installation erneut prüfen.",
  busy: "Für diesen Server läuft bereits eine Installation.",
  confirmationRequired: "Bitte die Installation des Pakets bestätigen.",
  previewBusy:
    "Gerade werden schon mehrere Pakete geprüft. Bitte gleich noch einmal versuchen.",
  toolchainBusy:
    "Gerade wird bereits eine Toolchain installiert. Bitte gleich erneut versuchen.",
  invalidConstraints:
    "Abhängigkeitsgrenzen bestehen aus einem PyPI-Paketnamen mit Versionsgrenzen pro Zeile (zum Beispiel fastmcp<4), höchstens 10.",
};
