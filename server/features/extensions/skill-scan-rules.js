// The patterns of the offline skill scan (skill-scan.js). Each one reads text only;
// nothing here runs, fetches or decodes what it finds. docs/shared-cli-extensions.md
// lists the rules and thresholds for owners.

/** Contiguous base64 or hex characters from which a run counts as an encoded blob. */
export const BLOB_LENGTH = 200;
/** Markdown proximity: a credential path and a network call this many lines apart. */
export const CREDENTIAL_DISTANCE = 20;

// Phrasing that tries to replace the owner's instructions or hide actions from them.
export const injectionPatterns = [
  /\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the|your|of)\s+)*(?:previous|prior|above|earlier|preceding|system|original)\s+(?:instructions?|prompts?|rules|directions|guidelines|messages)\b/iu,
  /\b(?:new|updated|real|actual|hidden)\s+system\s+prompt\b/iu,
  /<\/?\s*(?:system|system_prompt|im_start|im_end)\s*>|\[\/?(?:SYSTEM|INST)\]/iu,
  /\b(?:do\s+not|don't|never)\s+(?:tell|inform|alert|notify|show|mention\s+(?:this\s+|it\s+)?to|reveal\s+(?:this\s+|it\s+)?to)\s+the\s+user\b/iu,
  /\bwithout\s+(?:telling|informing|asking|notifying|alerting)\s+the\s+user\b/iu,
  /\b(?:hide|conceal)\s+(?:this|it|these|that|them|the\s+\w+)\s+from\s+the\s+user\b/iu,
  /\b(?:bypass|disable|circumvent|turn\s+off|ignore)\s+(?:(?:the|all|any|your)\s+)?(?:safety|security|guardrails?|sandbox(?:ing)?|permission(?:s|\s+checks?|\s+prompts?)?|approvals?|content\s+polic(?:y|ies))\b/iu,
  /--dangerously-skip-permissions\b|--dangerously-bypass-approvals-and-sandbox\b/iu,
  /\b(?:ignoriere|ignorier|vergiss|missachte)\s+(?:(?:alle|die|deine|sämtliche)\s+)*(?:vorherigen|bisherigen|obigen|vorigen|ursprünglichen)\s+(?:Anweisungen|Anordnungen|Regeln|Instruktionen|Vorgaben)\b/iu,
  /\bohne\s+(?:den|die)\s+(?:Nutzer|Benutzer|Anwender)(?:in)?\s+zu\s+(?:fragen|informieren|benachrichtigen)\b/iu,
  /\b(?:sag|sage|erzähl|erzähle|verrate)\s+(?:es\s+)?(?:dem|der)\s+(?:Nutzer|Benutzer|Anwender)(?:in)?\s+nichts\b/iu,
];

const fetchers = String.raw`curl|wget|aria2c|Invoke-WebRequest|Invoke-RestMethod|iwr|irm`;
const runners = String.raw`(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+(?:\S+=\S*\s+)*)?(?:(?:ba|z|da|k|fi|tc)?sh|python[0-9.]*|perl|ruby|node|deno|bun|php|pwsh|powershell|iex|Invoke-Expression|source)`;

// A download handed straight to an interpreter, or saved and then made executable.
export const downloadExecPatterns = [
  new RegExp(String.raw`\b(?:${fetchers})\b[^|\n]*(?<!\|)\|(?!\|)\s*${runners}\b`, "iu"),
  /\b(?:(?:ba|z|da|k)?sh|source|eval)\s+(?:-[a-z]+\s+)*["']?(?:\$\(|`)\s*(?:curl|wget)\b/iu,
  /(?:^|[\s;&|(])(?:(?:ba|z|da|k)?sh|source|\.|python[0-9.]*)\s+<\(\s*(?:curl|wget)\b/iu,
  /\b(?:iex|Invoke-Expression)\b[\s(]*(?:New-Object\s+(?:System\.)?Net\.WebClient\)?\s*\.\s*DownloadString|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b/iu,
  /\.DownloadString\s*\([^)\n]*\)\s*\|\s*(?:iex|Invoke-Expression)\b/iu,
  /\b(?:curl|wget)\b[^\n]*(?:&&|;)\s*(?:sudo\s+)?(?:chmod\s+(?:[ugoa]*\+[rw]*x|[0-7]{3,4})\b|(?:ba|z)?sh\s+\S|\.\/\S)/iu,
  /\b(?:exec|eval|Function)\s*\(.*\b(?:urlopen|requests\.get|fetch|https?\.get|DownloadString)\s*\(/iu,
];

// Files that hold secrets: SSH keys, cloud and Git credentials, .env, the keychain.
export const credentialPattern =
  /\.ssh\/|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|\.aws\/(?:credentials|config)\b|(?:^|[\s"'`=(:/,[])\.(?:env(?:\.[\w-]+)?|netrc|git-credentials)\b|\.docker\/config\.json|\.kube\/config\b|\.gnupg\b|\.config\/gh\/hosts\.yml|\bsecurity\s+(?:find-generic-password|find-internet-password|dump-keychain)\b|Library\/Keychains|\.keychain(?:-db)?\b|\/etc\/shadow\b/iu;

// Calls that send data to another host (not bare URLs in prose).
export const networkPattern =
  /\b(?:curl|wget|nc|ncat|netcat|socat|scp|sftp|rsync|ftp|telnet)\s|\/dev\/(?:tcp|udp)\/|\bfetch\s*\(|\baxios\b|\brequests\.(?:get|post|put|patch|request)\s*\(|\burllib\b|\burlopen\s*\(|\bhttps?\.request\s*\(|\bhttp\.client\b|\bInvoke-(?:WebRequest|RestMethod)\b|\b(?:iwr|irm)\s|\bNet\.WebClient\b|\bsocket\.(?:connect|create_connection)\b|\bXMLHttpRequest\b|\bsendBeacon\b/iu;

const hexRun = new RegExp(String.raw`\b(?:0x)?[0-9a-fA-F]{${BLOB_LENGTH},}\b`, "gu");
const hexEscapes = new RegExp(
  String.raw`(?:\\x[0-9a-fA-F]{2}){${BLOB_LENGTH / 4},}`,
  "u",
);
const base64Run = new RegExp(String.raw`[A-Za-z0-9+/_-]{${BLOB_LENGTH},}={0,2}`, "gu");

/** The index of the first encoded blob on `line`, or -1. */
export function blobIndex(line) {
  const escaped = hexEscapes.exec(line);
  if (escaped) return escaped.index;
  // Hex dumps mix digits and letters; a long run of either alone is not one.
  for (const found of line.matchAll(hexRun))
    if (/[0-9]/.test(found[0]) && /[a-fA-F]/.test(found[0])) return found.index;
  for (const found of line.matchAll(base64Run))
    // Real base64 mixes cases and digits; long words or identifiers do not.
    if (/[A-Z]/.test(found[0]) && /[a-z]/.test(found[0]) && /[0-9]/.test(found[0]))
      return found.index;
  return -1;
}

const bidi = (cp) => (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
const tag = (cp) => cp >= 0xe0000 && cp <= 0xe007f;
const supplementSelector = (cp) => cp >= 0xe0100 && cp <= 0xe01ef;
const selector = (cp) => cp >= 0xfe00 && cp <= 0xfe0f;
const skinTone = (cp) => cp >= 0x1f3fb && cp <= 0x1f3ff;
const pictographic = (cp) =>
  cp !== undefined && /\p{Extended_Pictographic}/u.test(String.fromCodePoint(cp));
// A letter or mark of a script that needs joiners (Indic, Arabic, Persian …).
const joiningLetter = (cp) =>
  cp !== undefined && cp > 0x7f && /[\p{L}\p{M}]/u.test(String.fromCodePoint(cp));
const ideograph = (cp) =>
  cp !== undefined && /\p{Ideographic}/u.test(String.fromCodePoint(cp));

/** The emoji a joiner at `index` follows, skipping its variation and skin tone. */
function emojiBefore(points, index) {
  let at = index - 1;
  while (at >= 0 && (selector(points[at]) || skinTone(points[at]))) at--;
  return pictographic(points[at]);
}

/**
 * The first hidden character on a line: `{ rule, index }` (code point index) or null.
 * Allowed: zero-width joiners inside emoji sequences and between letters of scripts
 * that need them, tag characters of a flag sequence (🏴 + tags + cancel tag), single
 * variation selectors, ideographic variation selectors after an ideograph and a byte
 * order mark at the start of a file.
 */
export function hiddenCharacter(points, { fileStart = false } = {}) {
  for (let index = 0; index < points.length; index++) {
    const cp = points[index];
    if (bidi(cp)) return { rule: "bidi-control", index };
    if (tag(cp)) {
      let end = index;
      while (end < points.length && tag(points[end])) end++;
      const flag =
        points[index - 1] === 0x1f3f4 &&
        points[end - 1] === 0xe007f &&
        end - index <= 8 &&
        points.slice(index, end - 1).every((point) => point >= 0xe0020);
      if (!flag) return { rule: "unicode-tag", index };
      index = end - 1;
      continue;
    }
    if (cp === 0x200d) {
      if (emojiBefore(points, index) && pictographic(points[index + 1])) continue;
      if (joiningLetter(points[index - 1]) && joiningLetter(points[index + 1])) continue;
      return { rule: "invisible-character", index };
    }
    if (cp === 0x200c) {
      if (joiningLetter(points[index - 1]) && joiningLetter(points[index + 1])) continue;
      return { rule: "invisible-character", index };
    }
    if (cp === 0xfeff && fileStart && index === 0) continue;
    if (
      cp === 0x200b ||
      cp === 0xfeff ||
      cp === 0x180e ||
      (cp >= 0x2060 && cp <= 0x2064) ||
      (supplementSelector(cp) && !ideograph(points[index - 1])) ||
      (selector(cp) && selector(points[index + 1]))
    )
      return { rule: "invisible-character", index };
  }
  return null;
}

/** Machine code: ELF, Mach-O (also fat/Java class), PE and WebAssembly headers. */
export function machineCode(data) {
  if (data.length < 4) return false;
  const head = data.readUInt32BE(0);
  return (
    head === 0x7f454c46 ||
    [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(head) ||
    head === 0x0061736d ||
    (data[0] === 0x4d && data[1] === 0x5a)
  );
}
