/** German browser-visible pipeline graph messages, addressed through English semantic keys. */
export const pipelineGraph = Object.freeze({
  nodeCount: "Eine Pipeline benötigt zwischen 1 und 100 Knoten",
  edgeLimit: "Eine Pipeline darf höchstens 300 Kanten enthalten",
  invalidNodeId: "Ungültige oder doppelte Knoten-ID",
  unsupportedNodeKind: (kind) => `Nicht unterstützte Art von Pipeline-Knoten: ${kind}`,
  invalidProfileReference: (node) => `Ungültiger Profilverweis am Knoten ${node}`,
  singlePullRequest: "Eine Pipeline darf nur einen Pull Request erstellen",
  entryMustBeProfile: "Der Einstieg muss auf einen Profilknoten verweisen",
  invalidEdge: "Ungültige Pipeline-Kante",
  oneEdgePerCondition: "Ein Knoten darf pro Bedingung nur eine Kante haben",
  loopBudgetRange: "Schleifenbudgets für Fehlschläge müssen zwischen 1 und 5 liegen",
  invalidSideEffectRouting: (node) =>
    `Ungültige Weiterleitung der Nebenwirkungen am Knoten ${node}`,
  cycleNeedsFailEdge: "Jeder Zyklus benötigt eine begrenzte Fehlschlag-Kante",
  failEdgeMustCloseCycle: "Eine begrenzte Fehlschlag-Kante muss einen Zyklus schließen",
  unreachableNode: "Jeder Knoten muss vom Einstieg aus erreichbar sein",
  invalidSideEffectCycle: "Ungültiger Zyklus aus Nebenwirkungen.",
  profileSnapshotMissing: "Der Profil-Snapshot der Pipeline fehlt.",
  invalidDefinitionId: "Ungültige Definitions-ID",
  definitionNotFound: "Pipeline-Definition nicht gefunden",
  definitionChanged:
    "Diese Definition wurde geändert. Bitte vor dem Speichern neu laden.",
});
