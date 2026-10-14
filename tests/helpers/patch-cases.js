// apply_patch inputs for the write guard tests: the hidden-hunk forms of the
// 2.0 review (B1), header and path variants and a seeded fuzz over them.
export const lineTerminators = ["\r", "\u2028", "\u2029", "\u0085", "\v", "\f"];
const odd = [...lineTerminators, "\t", " ", "\u00a0", "\ufeff", '"', "'", "*", "/", ".."];
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
  const cases = [...hiddenHunks];
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
