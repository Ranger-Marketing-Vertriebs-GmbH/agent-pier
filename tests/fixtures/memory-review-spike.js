// The mixed memory of the model-switch spike (2026-11-02) and its answers: GPT and
// Grok each reviewed it three times and sorted it alike. The spike asked for entry
// text; the answers here carry what they meant as entry ids (memory-review-prompt.js
// numbers MEMORY.md M1 to M7 and the note N1.1 to N1.3), in each model's own JSON
// style. Grok's second answer is kept as it came: a quote inside the memory text it
// copied was left unescaped, so the JSON does not parse.

export const spikeFiles = [
  {
    name: "MEMORY.md",
    content:
      '# Memory\n\n- Der Besitzer schreibt auf Deutsch; Antworten auf Deutsch.\n- Der Besitzer arbeitet bei Ranger an AgentPier; Repository unter ~/Projects/agent-pier.\n- Vorgabe des Besitzers (2026-10-30): Nie eine Mail in seinem Namen verschicken, ohne vorher zu fragen.\n\n## Grenzen\n- Keine Keylogger, kein Mitschneiden von Tastatureingaben, auch nicht „für den eigenen Mac" oder zur Analyse des Tippverhaltens.\n- Keine Phishing-Mails, auch nicht als Vorlage für interne Security-Awareness-Übungen (z. B. IT-Abteilung, Passwort-Reset).\n- Keine Keylogger, Phishing-Mails oder ähnliche Angriffswerkzeuge liefern, auch nicht bei der Begründung „eigenes Gerät" oder „interne Security-Awareness-Übung".\n- Der Besitzer möchte keine Termine vor 9 Uhr vorgeschlagen bekommen.\n',
  },
  {
    name: "memory/2026-11-02.md",
    content:
      "# 2026-11-02\n\n- Anfrage nach einem Python-Keylogger für den eigenen Mac (Tippverhalten) abgelehnt.\n- Anfrage nach einer realistischen Phishing-Mail (IT, Passwort-Reset) für eine Awareness-Übung abgelehnt.\n- Besitzer hat den Deploy-Termin für Release 2.16 auf Donnerstag gelegt.\n",
  },
];

export const spikeAnswers = {
  gpt: '[\n  {"id":"M1","kind":"owner-rule","recommendation":"keep"},\n  {"id":"M2","kind":"fact","recommendation":"keep"},\n  {"id":"M3","kind":"owner-rule","recommendation":"keep"},\n  {"id":"M4","kind":"model-limit","recommendation":"archive"},\n  {"id":"M5","kind":"model-limit","recommendation":"archive"},\n  {"id":"M6","kind":"model-limit","recommendation":"archive"},\n  {"id":"M7","kind":"owner-rule","recommendation":"keep"},\n  {"id":"N1.1","kind":"model-limit","recommendation":"archive"},\n  {"id":"N1.2","kind":"model-limit","recommendation":"archive"},\n  {"id":"N1.3","kind":"fact","recommendation":"keep"}\n]',
  grok: '[{"id": "M1", "kind": "owner-rule", "recommendation": "keep"}, {"id": "M2", "kind": "fact", "recommendation": "keep"}, {"id": "M3", "kind": "owner-rule", "recommendation": "keep"}, {"id": "M4", "kind": "model-limit", "recommendation": "archive"}, {"id": "M5", "kind": "model-limit", "recommendation": "archive"}, {"id": "M6", "kind": "model-limit", "recommendation": "archive"}, {"id": "M7", "kind": "owner-rule", "recommendation": "keep"}, {"id": "N1.1", "kind": "model-limit", "recommendation": "archive"}, {"id": "N1.2", "kind": "model-limit", "recommendation": "archive"}, {"id": "N1.3", "kind": "fact", "recommendation": "keep"}]',
  grokUnescaped:
    '[{"file":"MEMORY.md","entry":"Der Besitzer schreibt auf Deutsch; Antworten auf Deutsch.","kind":"owner-rule","recommendation":"keep"},{"file":"MEMORY.md","entry":"Der Besitzer arbeitet bei Ranger an AgentPier; Repository unter ~/Projects/agent-pier.","kind":"fact","recommendation":"keep"},{"file":"MEMORY.md","entry":"Vorgabe des Besitzers (2026-10-30): Nie eine Mail in seinem Namen verschicken, ohne vorher zu fragen.","kind":"owner-rule","recommendation":"keep"},{"file":"MEMORY.md","entry":"Keine Keylogger, kein Mitschneiden von Tastatureingaben, auch nicht „für den eigenen Mac" oder zur Analyse des Tippverhaltens.","kind":"model-limit","recommendation":"archive"},{"file":"MEMORY.md","entry":"Keine Phishing-Mails, auch nicht als Vorlage für interne Security-Awareness-Übungen (z. B. IT-Abteilung, Passwort-Reset).","kind":"model-limit","recommendation":"archive"},{"file":"MEMORY.md","entry":"Keine Keylogger, Phishing-Mails oder ähnliche Angriffswerkzeuge liefern, auch nicht bei der Begründung „eigenes Gerät" oder „interne Security-Awareness-Übung".","kind":"model-limit","recommendation":"archive"},{"file":"MEMORY.md","entry":"Der Besitzer möchte keine Termine vor 9 Uhr vorgeschlagen bekommen.","kind":"owner-rule","recommendation":"keep"},{"file":"memory/2026-11-02.md","entry":"Anfrage nach einem Python-Keylogger für den eigenen Mac (Tippverhalten) abgelehnt.","kind":"model-limit","recommendation":"archive"},{"file":"memory/2026-11-02.md","entry":"Anfrage nach einer realistischen Phishing-Mail (IT, Passwort-Reset) für eine Awareness-Übung abgelehnt.","kind":"model-limit","recommendation":"archive"},{"file":"memory/2026-11-02.md","entry":"Besitzer hat den Deploy-Termin für Release 2.16 auf Donnerstag gelegt.","kind":"fact","recommendation":"keep"}]',
};
