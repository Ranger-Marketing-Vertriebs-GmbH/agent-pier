import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { loadCatalogs } from "../../scripts/i18n-translation-lock.mjs";

// German names a stored provider connection "Provider-Zugang", like the sibling
// "SSH-Zugänge" and "GitHub-Zugänge"; a second term for the same thing confuses users.
test("German catalogs use one term for provider connections", async () => {
  for (const dir of ["../../web/lib/i18n/de/", "../../server/lib/i18n/de/"]) {
    const base = new URL(dir, import.meta.url);
    for (const name of await readdir(base)) {
      if (!name.endsWith(".js")) continue;
      const text = await readFile(new URL(name, base), "utf8");
      assert.doesNotMatch(text, /Provider-Verbindung/, `${dir}${name}`);
      // Agent copy once called the same thing "Modellverbindung" or "diese Verbindung";
      // remote access copy describes a network connection and keeps the word.
      if (name === "remote.js") continue;
      assert.doesNotMatch(
        text,
        /Modell-?verbindung|diese Verbindung\b|Verbindung fehlt/i,
        `${dir}${name}`,
      );
    }
  }
});

// Pipeline copy calls automated checks "Prüfung"/"Prüfschritt" and a run "Lauf".
test("German pipeline catalogs use one term for verification and the run branch", async () => {
  for (const dir of ["../../web/lib/i18n/de/", "../../server/lib/i18n/de/"]) {
    const base = new URL(dir, import.meta.url);
    for (const name of await readdir(base)) {
      if (!name.startsWith("pipeline")) continue;
      const text = await readFile(new URL(name, base), "utf8");
      assert.doesNotMatch(text, /Verifikation|Run-Branch/, `${dir}${name}`);
    }
  }
});

// UI glossary (docs/ui-glossary.md): German copy says "Session", "Tool" and
// "Accounts" (the page), and navigation paths use "›" in both languages.
// Rendered texts of the web and server catalogs, as the translation lock reads them.
async function catalogTexts(language) {
  const texts = [];
  for (const kind of ["web", "server"]) {
    const catalogs = await loadCatalogs(kind);
    for (const lang of language ? [language] : ["german", "english"])
      for (const [key, text] of catalogs[lang])
        texts.push({ where: `${kind} ${key}`, text });
  }
  return texts;
}

test("German catalogs follow the UI glossary", async () => {
  for (const { where, text } of await catalogTexts("german")) {
    assert.doesNotMatch(text, /Sitzung|sitzung/, where);
    assert.doesNotMatch(text, /Werkzeug|werkzeug/, where);
    assert.doesNotMatch(text, /\bKonten\b|Kontoeinstellung/, where);
    assert.doesNotMatch(text, /Zugänge →/, where);
  }
});

test("navigation paths use › and ellipses follow a space", async () => {
  for (const { where, text } of await catalogTexts()) {
    assert.doesNotMatch(text, /\p{L} (→|>) \p{Lu}/u, where);
    // Placeholders such as ${…} or {env:…} quote syntax and keep their form.
    const prose = text.replace(/\$\{…\}|\{(env|file):…\}|<U\+…>/g, "");
    assert.doesNotMatch(prose, /[^\s„“"'(]…/u, where);
  }
});

// Proper nouns and key names that keep their capitals inside short labels.
const properNouns = [
  /GitHub App/g,
  /Brave Search/g,
  /Claude Code/g,
  /Z\.ai Coding Plan/g,
  /OpenAI Chat Completions|Chat Completions|OpenAI Responses|Anthropic Messages/g,
  /MCP Registry/g,
  /(Up|Down|Left|Right) Arrow|Escape|Tab|Enter|Control C/g,
  /\b(Telegram|Deepgram|GitHub|Codex|OpenCode|OpenClaw|ChatGPT|AgentPier|CLI|MCP|SSH|API|URL|ID)\b/g,
  /\b(Agency|AgentBus|Claude|Brave|Perplexity|OpenRouter|PyPI|Ed25519|Unicode|KiB|MiB|GiB)\b/g,
  // Page names and the editor's Save As command.
  /\b(in|under) (Accounts|Artifacts|Settings)\b/g,
  /Save As/g,
];
test("English labels use sentence case", async () => {
  const titleCase = [];
  for (const { where, text } of await catalogTexts("english")) {
    const words = text.trim().split(/\s+/);
    if (words.length < 2 || words.length > 6 || /[.:?!]\s|[.?!]$/.test(text)) continue;
    let rest = text;
    for (const noun of properNouns) rest = rest.replace(noun, "x");
    // A separator such as "·", "—" or "/" starts a new label part.
    const capitalised = rest
      .split(/\s[·—/]\s|^[^\p{L}_]+/u)
      .flatMap((part) => part.trim().split(/\s+/).slice(1))
      .filter((word) => /^[A-Z][a-z]/.test(word));
    if (capitalised.length) titleCase.push(`${where}: ${JSON.stringify(text)}`);
  }
  assert.deepEqual(titleCase, []);
});

// UI glossary: "Benutzer"/"user" names a restricted user, never the owner. Copy the
// owner sees about his own account names him "Besitzer"/"owner", and the Activity
// log subtitle lists the owner beside users instead of calling him a user.
test("owner-facing copy names the owner, not a user", async () => {
  const ownerKeys = [
    "web login:loginCopy.setup",
    "web login:loginCopy.errors.LOGIN_ALREADY_CONFIGURED",
    "server login.exists",
    "web settings:settingsHubCopy.auditSub",
  ];
  const takenKeys = [
    "web login:loginCopy.errors.LOGIN_USERNAME_TAKEN",
    "server login.usernameTaken",
  ];
  for (const [language, owner, user] of [
    ["german", /Besitzer/, /\bBenutzer\b/],
    ["english", /\b[Oo]wner\b/, /\b[Uu]ser\b/],
  ]) {
    const texts = new Map((await catalogTexts(language)).map((e) => [e.where, e.text]));
    for (const key of ownerKeys) {
      const text = texts.get(key);
      assert.ok(text, `${language} ${key} missing`);
      assert.match(text, owner, `${language} ${key}`);
      if (!key.endsWith("auditSub"))
        assert.doesNotMatch(text, user, `${language} ${key}`);
    }
    // The owner's own name can collide too, so the message names no person.
    for (const key of takenKeys)
      assert.doesNotMatch(texts.get(key), user, `${language} ${key}`);
  }
});
