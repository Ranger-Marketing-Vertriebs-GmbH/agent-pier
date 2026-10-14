// apply_patch inputs for the write guard tests: the hidden-hunk forms of the
// 2.0 review (B1), header and path variants and a seeded fuzz over them.
export const lineTerminators = ["\r", "\u2028", "\u2029", "\u0085", "\v", "\f"];
const odd = [
  ...lineTerminators,
  "\t",
  " ",
  "\u00a0",
  "\ufeff",
  "\u0000",
  "\u200b",
  "\u180e",
  "\u3000",
  '"',
  "'",
  "*",
  "/",
  "..",
];
export const envelope = (...lines) =>
  ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
// The review's proof of concept: an ordinary hunk hides one aimed at an instruction file.
export const hiddenHunks = [
  envelope(
    "*** Add File: notes/ok.md",
    "+ok",
    "*** Update File: x\u2028/../AGENTS.md",
    "@@",
    "+PLANTED_LS",
  ),
  envelope(
    "*** Add File: notes/ok2.md",
    "+ok",
    "*** Add File: y\r/../SOUL.md",
    "+PLANTED_CR",
  ),
  envelope(
    "*** Add File: notes/ok3.md",
    "+ok",
    "*** Add File: z\u2029/../skills/evil/SKILL.md",
    "+PLANTED_SKILL",
  ),
];
// The re-review's variants (header, path, link and envelope forms), run as given.
const ordinary = ["*** Add File: notes/ok.md", "+ok"];
const long = "a".repeat(5000);
export const reviewVariants = {
  nulPath: envelope(...ordinary, "*** Add File: n\u0000/../SOUL.md", "+x"),
  bomHeader: envelope(...ordinary, "\ufeff*** Add File: SOUL.md", "+x"),
  bomPath: envelope(...ordinary, "*** Add File: \ufeffSOUL.md", "+x"),
  nbspHeaderEnd: envelope(...ordinary, "*** Add File: SOUL.md\u00a0", "+x"),
  zwspPath: envelope(...ordinary, "*** Add File: SO\u200bUL.md", "+x"),
  nfdPath: envelope(...ordinary, "*** Add File: notes/../SOU\u0301L.md", "+x"),
  overlong: envelope(...ordinary, `*** Add File: ${long}/../SOUL.md`, "+x"),
  overlongLine: envelope(
    ...ordinary,
    `*** Add File: notes/${long}${long}${long}.md`,
    "+x",
  ),
  mixedCRLF: envelope(...ordinary, "*** Add File: SOUL.md", "+x").replace(/\n/g, "\r\n"),
  moveAbs: envelope(
    "*** Update File: notes/existing.md",
    "*** Move to: /tmp/rv-escape.md",
    "@@",
    "-a",
    "+b",
  ),
  moveDotDot: envelope(
    "*** Update File: notes/existing.md",
    "*** Move to: ../escape.md",
    "@@",
    "-a",
    "+b",
  ),
  moveSpaces: envelope(
    "*** Update File: notes/existing.md",
    "*** Move to:   SOUL.md",
    "@@",
    "-a",
    "+b",
  ),
  moveEmpty: envelope(
    "*** Update File: notes/existing.md",
    "*** Move to: ",
    "@@",
    "-a",
    "+b",
  ),
  moveTwice: envelope(
    "*** Update File: notes/existing.md",
    "*** Move to: notes/a.md",
    "*** Move to: SOUL.md",
    "@@",
    "-a",
    "+b",
  ),
  moveIndented: envelope(
    "*** Update File: notes/existing.md",
    "    *** Move to: SOUL.md",
    "@@",
    "-a",
    "+b",
  ),
  moveDotSlash: envelope(
    "*** Update File: notes/existing.md",
    "*** Move to: ./notes/../SOUL.md",
    "@@",
    "-a",
    "+b",
  ),
  atPrefix: envelope(...ordinary, "*** Add File: @SOUL.md", "+x"),
  atAt: envelope(...ordinary, "*** Add File: @@SOUL.md", "+x"),
  tilde: envelope(...ordinary, "*** Add File: ~/rv-escape.md", "+x"),
  fileUrl: envelope(...ordinary, "*** Add File: file:///tmp/rv-escape.md", "+x"),
  backslash: envelope(...ordinary, "*** Add File: notes\\..\\SOUL.md", "+x"),
  winDrive: envelope(...ordinary, "*** Add File: C:/x.md", "+x"),
  selflinkAdd: envelope(...ordinary, "*** Add File: selflink/SOUL.md", "+x"),
  selflinkUpdate: envelope(
    "*** Update File: selflink/AGENTS.md",
    "@@",
    "-orig",
    "+PLANTED",
  ),
  selflinkMove: envelope(
    "*** Update File: notes/existing.md",
    "*** Move to: selflink/SOUL.md",
    "@@",
    "-a",
    "+b",
  ),
  siblinkAdd: envelope(...ordinary, "*** Add File: siblink/x.md", "+x"),
  deleteLink: envelope("*** Delete File: selflink"),
  eofInAdd: envelope(
    "*** Add File: notes/a.md",
    "+x",
    "*** End of File",
    "*** Add File: SOUL.md",
    "+y",
  ),
  ctxStar: envelope(
    "*** Update File: notes/existing.md",
    "@@",
    "-a",
    "+b",
    "***Add File: SOUL.md",
  ),
  emptyCtxThenHeader: envelope(
    "*** Update File: notes/existing.md",
    "@@",
    "*** Add File: SOUL.md",
    "+x",
  ),
  heredocInner: `<<EOF\n${envelope(...ordinary, "*** Add File: SOUL.md", "+x")}\nEOF`,
  heredocNested: `<<EOF\n<<EOF\n${envelope(...ordinary)}\nEOF\n*** Add File: SOUL.md\nEOF`,
  dirAsFile: envelope("*** Delete File: notes"),
  skillsDir: envelope(...ordinary, "*** Add File: Skills/x/SKILL.md", "+x"),
  agentsDotSlash: envelope("*** Delete File: ./AGENTS.md"),
  trailingSlash: envelope(...ordinary, "*** Add File: SOUL.md/", "+x"),
};
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
export function patchCases(count = 400, seed = 20261014) {
  const next = random(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const target = () =>
    pick(["notes/new.md", "notes/existing.md", "AGENTS.md", "SOUL.md", "x/../AGENTS.md"]);
  const mangle = (text) => {
    let out = text;
    for (let n = Math.floor(next() * 3); n > 0; n--) {
      const at = Math.floor(next() * (out.length + 1));
      out = out.slice(0, at) + pick(odd) + out.slice(at);
    }
    return out;
  };
  const hunks = [
    () => [`*** Add File: ${target()}`, "+x"],
    () => ["*** Update File: notes/existing.md", "@@", "-a", "+b"],
    () => [
      "*** Update File: notes/existing.md",
      `*** Move to: ${target()}`,
      "@@",
      "-a",
      "+b",
    ],
    () => [`*** Delete File: ${target()}`],
    () => [
      "*** Update File: notes/existing.md",
      "@@",
      " *** Add File: AGENTS.md",
      "-a",
      "+b",
    ],
  ];
  const cases = [...hiddenHunks, ...Object.values(reviewVariants)];
  for (let n = 0; n < count; n++) {
    const lines = [];
    for (let h = 1 + Math.floor(next() * 3); h > 0; h--) lines.push(...pick(hunks)());
    // Mangle one line (header, path or content) in most cases.
    if (next() < 0.8) {
      const at = Math.floor(next() * lines.length);
      lines[at] = mangle(lines[at]);
    }
    const body = envelope(...lines);
    cases.push(next() < 0.1 ? `<<EOF\n${body}\nEOF` : body);
  }
  return cases;
}
