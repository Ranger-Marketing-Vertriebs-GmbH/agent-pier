import test from "node:test";
import { randomInt } from "node:crypto";
import assert from "node:assert/strict";
import {
  profileTools,
  routineTools,
  shellTools,
} from "../../server/features/assistants/native-capabilities.js";
import {
  classifyWrite,
  patchPaths,
  writeTools,
} from "../../server/features/assistants/team-plugin/tool-guard.js";
import {
  envelope as wrap,
  hiddenHunks,
  lineTerminators,
  patchCases,
} from "../helpers/patch-cases.js";

// Tools AgentPier grants that never change a file. A new granted tool must be put
// here, behind the write guard (writeTools), or behind shell approvals.
const readOnly = [
  "session_status",
  "memory_search",
  "memory_get",
  "read",
  // Loads an installed skill's SKILL.md; it grants no further tool.
  "skills_read",
  "web_search",
  "web_fetch",
  "browser",
  "view_image",
  // Writes only into OpenClaw's managed media (state/media), never the workspace.
  // Local reference images come from the workspace and OpenClaw's shared media folder
  // (tools.fs.workspaceOnly); web references are refused by the tool guard unless the
  // agent may read web pages (tool-guard.js imageCall).
  "image_generate",
  // Reads workspace PDFs with the model the tool guard names (pdf-policy.js); the
  // guard refuses web addresses and replaces any model the agent names.
  "pdf",
];
const everything = {
  memory: true,
  reminders: true,
  webSearch: true,
  webFetch: true,
  browser: true,
  documents: true,
  readPdfs: true,
  createImages: true,
};

test("every file tool an agent can be granted is behind the write guard", () => {
  const granted = new Set([
    ...profileTools({ capabilities: everything, shell: "full" }, true, true, true),
    ...routineTools,
    // OpenClaw grants apply_patch wherever write is allowed (writeAllowsApplyPatch)
    // and, since 2026.10.3, skills_read wherever read is.
    "apply_patch",
    "skills_read",
  ]);
  for (const tool of granted) {
    if (tool.includes("__") || tool.startsWith("agentpier_")) continue;
    assert.ok(
      readOnly.includes(tool) || writeTools.includes(tool) || shellTools.includes(tool),
      `${tool} is unaccounted for`,
    );
  }
  for (const tool of ["write", "edit", "apply_patch"])
    assert.ok(writeTools.includes(tool), tool);
});

// OpenClaw 2026.10.3 allows skills_read wherever `read` is allowed and not denied
// (tool-policy-match). Accepted in AGENTPIER-69: AgentPier never names the tool and
// compiles no tool deny list, so it follows `read`, which only memory grants.
test("skills_read reaches exactly the agents granted read", () => {
  const tools = (capabilities) =>
    profileTools({ capabilities, shell: "full" }, true, true, true);
  assert.ok(tools(everything).includes("read"));
  assert.ok(!tools({ ...everything, memory: false }).includes("read"));
  assert.ok(routineTools.includes("read"));
  for (const granted of [tools(everything), routineTools])
    assert.ok(!granted.includes("skills_read"));
});

test("a patch's paths include every hunk header OpenClaw would apply", () => {
  const envelope = (...lines) =>
    ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
  assert.deepEqual(
    patchPaths(
      envelope(
        "*** Add File: a.md",
        "+x",
        "  *** Update File: b.md",
        "*** Move to: c.md",
        "@@",
        "-y",
        "+z",
        "*** Delete File: d.md",
      ),
    ),
    ["a.md", "b.md", "c.md", "d.md"],
  );
  assert.deepEqual(patchPaths(`<<EOF\n${envelope("*** Add File: e.md", "+x")}\nEOF`), [
    "e.md",
  ]);
  assert.equal(patchPaths(envelope("nothing")), null);
  assert.equal(patchPaths(undefined), null);
});

test("a patch with a foreign line terminator, an unknown header or an ambiguous line is refused", () => {
  for (const input of hiddenHunks) assert.equal(patchPaths(input), null);
  const headers = [
    "*** Add File: ",
    "*** Delete File: ",
    "*** Update File: ",
    "*** Move to: ",
  ];
  for (const terminator of lineTerminators)
    for (const header of headers) {
      const body =
        header === "*** Move to: "
          ? [
              "*** Update File: notes/a.md",
              `${header}x${terminator}/../AGENTS.md`,
              "@@",
              "+b",
            ]
          : [
              `${header}x${terminator}/../AGENTS.md`,
              ...(header.includes("Delete")
                ? []
                : header.includes("Update")
                  ? ["@@", "+b"]
                  : ["+b"]),
            ];
      assert.equal(
        patchPaths(wrap("*** Add File: notes/ok.md", "+ok", ...body)),
        null,
        JSON.stringify([header, terminator]),
      );
    }
  // CRLF patches are refused as a whole, too.
  assert.equal(
    patchPaths(wrap("*** Add File: notes/a.md", "+a").replaceAll("\n", "\r\n")),
    null,
  );
  for (const lines of [
    // Tabs make no header OpenClaw knows, so no header the guard may skip.
    ["*** Add File:\tAGENTS.md", "+x"],
    ["***\tAdd File: AGENTS.md", "+x"],
    ["*** add file: AGENTS.md", "+x"],
    ["*** Copy File: AGENTS.md"],
    // A header-looking context line inside an update hunk.
    ["*** Update File: notes/a.md", "@@", " *** Add File: AGENTS.md", "+b"],
    // No hunk at all, or an empty update.
    ["nothing"],
    ["*** Update File: notes/a.md"],
  ])
    assert.equal(patchPaths(wrap(...lines)), null, JSON.stringify(lines));
  // Quoted paths and move targets are read literally, as OpenClaw reads them.
  assert.deepEqual(patchPaths(wrap('*** Add File: "AGENTS.md"', "+x")), ['"AGENTS.md"']);
  assert.deepEqual(
    patchPaths(wrap("*** Update File: notes/a.md", "*** Move to: AGENTS.md", "@@", "+b")),
    ["notes/a.md", "AGENTS.md"],
  );
  assert.deepEqual(
    patchPaths(wrap("*** Update File: notes/a.md", "@@", "-a", "+b", "*** End of File")),
    ["notes/a.md"],
  );
});

test("whatever a fuzzed patch names, no line separator reaches a checked path", () => {
  // A new seed each run; a failure names it (AGENTPIER_PATCH_FUZZ_SEED replays it).
  const seed = Number(process.env.AGENTPIER_PATCH_FUZZ_SEED) || randomInt(1, 2 ** 31);
  for (const input of patchCases(2000, seed)) {
    const paths = patchPaths(input);
    if (!paths) continue;
    for (const target of paths)
      assert.doesNotMatch(
        target,
        /[\r\n\u2028\u2029\u0085\v\f]/,
        `seed ${seed}: ${JSON.stringify(input)}`,
      );
  }
});

test("write targets never hold control or line-separator characters", () => {
  const options = { roots: ["/workspaces"], agentId: "ap-agent" };
  assert.deepEqual(classifyWrite({ path: "notes/a.md" }, options), {
    path: "notes/a.md",
  });
  for (const character of [...lineTerminators, "\n", "\u0000", "\u001b", "\u009b", "\t"])
    assert.deepEqual(
      classifyWrite({ path: `notes/a${character}.md` }, options),
      { outside: true },
      JSON.stringify(character),
    );
  // A quoted instruction file name is never a plain root name.
  assert.deepEqual(classifyWrite({ path: '"AGENTS.md"' }, options), { bootstrap: true });
});
