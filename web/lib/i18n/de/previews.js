export const previewCopy = {
  title: "Vorschauen",
  open: "Vorschau öffnen",
  stop: "Beenden",
  port: (port) => `Port ${port}`,
  description:
    "Coding-Sessions und Agenten können dir ihren laufenden Dev-Server zeigen. Jede Vorschau bekommt einen eigenen Port aus dem Bereich unten, unter derselben Adresse wie AgentPier. Nur du kannst sie öffnen.",
  enable: "Vorschauen einschalten",
  enableSub:
    "Solange sie an sind, hört AgentPier auf den Ports unten. Standardmäßig aus.",
  rangeStart: "Erster Port",
  rangeEnd: "Letzter Port",
  rangeSub: "Von 1024 bis 65535, höchstens 50 Ports.",
  locked: "Einfacher Netzwerkzugriff kann Vorschauen nur ausschalten.",
  portsTitle: "Ports",
  slotFree: "Frei",
  slotTaken: "Von einem anderen Programm belegt",
  slotPreview: "Vorschau",
  activeTitle: "Aktive Vorschauen",
  saved: "Gespeichert.",
  loading: "Vorschauen werden geladen …",
  serveTitle: "Tailscale",
  serveRegistered: (count) =>
    count === 1
      ? "1 Port im Tailnet freigegeben"
      : `${count} Ports im Tailnet freigegeben`,
  serveFailed: (ports) => `Nicht freigegeben: ${ports}`,
  serveCommandsHint:
    "Führe diese Befehle auf dem AgentPier-Rechner aus und schalte Vorschauen danach aus und wieder ein.",
  serveOccupied: (ports) =>
    `Eine andere Tailscale-Serve-Freigabe nutzt ${ports}. Wähle einen anderen Portbereich.`,
  serveNetwork:
    "Der Netzwerkzugriff ist an: Vorschauen öffnen über die Netzwerkadressen, nicht über Tailscale.",
  serveCopy: "Befehle kopieren",
};
