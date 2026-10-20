/** Messages of the per-project run queue (pipeline-queue routes and run-queue.js). */
export const pipelineQueue = Object.freeze({
  itemNotFound: "Dieser Eintrag ist nicht mehr in der Warteschlange.",
  invalidTask: "Gib eine Aufgabe mit höchstens 64 KiB an.",
  invalidBaseBranch:
    "Der Basis-Branch darf höchstens 300 Zeichen lang sein und keine Steuerzeichen enthalten.",
  invalidExternalRef:
    "Die externe Referenz darf höchstens 120 Zeichen lang sein und keine Steuerzeichen enthalten.",
  full: "Die Warteschlange dieses Projekts ist voll: Höchstens 200 Einträge dürfen warten.",
  notWaiting: "Nur wartende Einträge lassen sich verschieben.",
  invalidMove: "Ein Eintrag lässt sich nur nach oben oder unten verschieben.",
  notFailed:
    "Nur ein Eintrag, dessen Start fehlgeschlagen ist, lässt sich erneut starten.",
  starting: "Dieser Eintrag wird gerade gestartet. Versuche es gleich noch einmal.",
  invalidSettings:
    "Gleichzeitige Läufe müssen eine ganze Zahl von 1 bis 20 sein, und ob wartende Läufe zählen, muss ja oder nein sein.",
  startFailed: "Der Lauf konnte nicht gestartet werden.",
  closed: "Die Warteschlange ist beendet.",
});
