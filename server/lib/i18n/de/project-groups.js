/** Messages of the project groups of the projects page (project-groups routes). */
export const projectGroups = Object.freeze({
  invalidDocument:
    "Die Gruppen müssen als Dokument mit Version, Gruppen und Zuordnungen kommen.",
  invalidName:
    "Der Gruppenname muss 1 bis 60 Zeichen lang sein und darf keine Steuerzeichen enthalten.",
  nameTaken: "Eine Gruppe mit diesem Namen gibt es schon.",
  unknownGroup: "Diese Gruppe gibt es nicht (mehr).",
  invalidAssignment:
    "Ein Projekt lässt sich nur über seinen absoluten Pfad einer vorhandenen Gruppe zuordnen.",
  tooMany: "Es sind höchstens 200 Gruppen und 500 Zuordnungen möglich.",
  conflict:
    "Die Gruppen wurden inzwischen an anderer Stelle geändert. Die aktuelle Fassung wird geladen.",
});
