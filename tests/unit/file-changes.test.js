import test from "node:test";
import assert from "node:assert/strict";
import {
  replacement,
  unifiedPatch,
  applyPatch,
  codePreview,
} from "../../server/features/chat/file-change-model.js";
import { toolFileChanges } from "../../server/features/chat/tool-file-changes.js";
import {
  normalizeClaude,
  normalizeCodex,
  normalizeCodexRecords,
  normalizeOpenCode,
} from "../../server/features/chat/history-parsers.js";
import { changePreview } from "../../web/features/chat/file-change-preview.js";
const path = "src/example.ts";
const before = "/* title\n * unchanged */\nconst café = 1;\n";
const after = "/* title\n * unchanged */\nconst café = 2;\n";
const patch =
  "@@ -10,3 +10,3 @@\n /* title\n  * unchanged */\n-const café = 1;\n+const café = 2;\n";
const command = `*** Begin Patch\n*** Update File: ${path}\n@@\n /* title\n  * unchanged */\n-const café = 1;\n+const café = 2;\n*** End Patch`;
const claude = (output) => [
  {
    type: "assistant",
    uuid: "a",
    message: {
      content: [
        {
          type: "tool_use",
          id: "edit",
          name: "Edit",
          input: { file_path: path, old_string: before, new_string: after },
        },
      ],
    },
  },
  ...(output
    ? [
        {
          type: "user",
          uuid: "r",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "edit",
                content: "done",
                is_error: output === "failed",
              },
            ],
          },
        },
      ]
    : []),
];
const opencode = (status, metadata = {}) => ({
  messages: [
    {
      info: { role: "assistant" },
      parts: [
        {
          id: "edit",
          type: "tool",
          tool: "edit",
          state: {
            status,
            input: { filePath: path, oldString: before, newString: after },
            metadata,
          },
        },
      ],
    },
  ],
});

test("provider edit records retain equivalent rows and independent completion state", () => {
  const expected = replacement(path, before, after);
  for (const status of ["running", "completed", "failed"]) {
    const c = normalizeClaude(claude(status === "running" ? null : status)).messages[0];
    const o = normalizeOpenCode(opencode(status === "failed" ? "error" : status))
      .messages[0];
    for (const row of [c, o]) {
      assert.equal(row.status, status);
      assert.deepEqual(row.fileChanges, [expected]);
    }
  }
  const native = normalizeCodex({
    turns: [
      {
        items: [
          {
            id: "edit",
            type: "fileChange",
            status: "completed",
            changes: [{ path, diff: patch, kind: { type: "update" } }],
          },
        ],
      },
    ],
  }).messages[0];
  assert.equal(native.fileChanges[0].rows[3].oldLine, 12);
  assert.equal(native.fileChanges[0].rows[4].newLine, 12);
  assert.deepEqual(
    native.fileChanges[0].rows
      .filter((r) => r.kind !== "meta")
      .map(({ kind, text }) => ({ kind, text })),
    expected.rows,
  );
  const o = normalizeOpenCode(opencode("completed", { diff: patch })).messages[0];
  assert.equal(o.fileChanges[0].provenance, "patch");
  assert.equal(
    normalizeOpenCode(opencode("error", { diff: patch })).messages[0].fileChanges[0]
      .provenance,
    "excerpt",
  );
});
test("Codex freeform and function patch calls preserve stable IDs and failed output", () => {
  for (const type of ["function_call", "custom_tool_call"]) {
    const call = {
      type: "response_item",
      payload: {
        type,
        call_id: "patch",
        name: "apply_patch",
        ...(type === "function_call"
          ? { arguments: JSON.stringify({ input: command }) }
          : { input: command }),
      },
    };
    const result = {
      type: "response_item",
      payload: {
        type: type.replace("call", "call_output"),
        call_id: "patch",
        output: "rejected",
        is_error: true,
      },
    };
    const pending = normalizeCodexRecords([call]).messages[0];
    const failed = normalizeCodexRecords([call, result]).messages[0];
    assert.equal(pending.status, "running");
    assert.equal(failed.status, "failed");
    assert.equal(failed.id, pending.id);
    assert.deepEqual(failed.fileChanges, pending.fileChanges);
    assert.equal(failed.fileChanges[0].added, 1);
  }
});
test("patch files cover creations, deletion summaries and renames without invented coordinates", () => {
  const files = applyPatch(
    '*** Begin Patch\n*** Add File: new.py\n+print("hi")\n*** Delete File: old.py\n*** Update File: from.py\n*** Move to: to.py\n@@\n-old\n+new\n*** End Patch',
  );
  assert.deepEqual(
    files.map((f) => f.operation),
    ["create", "delete", "rename"],
  );
  assert.equal(files[1].rows.length, 0);
  assert.equal(files[2].movePath, "to.py");
  assert.equal(files[0].rows[0].newLine, undefined);
  const native = toolFileChanges(
    "apply_patch",
    { patchText: command },
    { files: [{ filePath: path, type: "move", movePath: "renamed.ts", patch }] },
  ).fileChanges[0];
  assert.equal(native.operation, "rename");
  assert.equal(native.provenance, "patch");
});
test("unknown writes remain previews and replacement excerpts never claim full-file positions", () => {
  const write = toolFileChanges("Write", { file_path: path, content: after })
    .fileChanges[0];
  assert.equal(write.provenance, "preview");
  assert.equal(write.added, 0);
  const edits = toolFileChanges("MultiEdit", {
    file_path: path,
    edits: [
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
    ],
  }).fileChanges;
  assert.equal(edits.length, 2);
  assert.ok(edits.every((file) => file.rows.every((row) => row.oldLine === undefined)));
  assert.deepEqual(
    toolFileChanges("Bash", { file_path: path, old_string: "a", new_string: "b" }),
    {},
  );
});
test("CRLF, empty lines, Unicode and final-newline evidence survive diffing", () => {
  const diff = replacement(path, "a\r\n\r\n旧\r\n", "a\n\n新\n");
  assert.deepEqual(
    diff.rows.map((r) => r.text),
    ["a", "", "旧", "新"],
  );
  assert.ok(replacement(path, "a\n", "a").rows.some((r) => r.kind === "meta"));
  assert.equal(
    unifiedPatch(path, "@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n").rows.at(-1)
      .kind,
    "meta",
  );
});
test("malformed, binary and oversized data fall back without partial structured claims", () => {
  assert.equal(unifiedPatch(path, "@@ -1,2 +1 @@\n-a\n+b"), null);
  assert.equal(unifiedPatch(path, "@@ -1 +1 @@\n-a\n+b\n-unexpected"), null);
  assert.deepEqual(applyPatch(command.replace("*** End Patch", "")), []);
  assert.equal(replacement(path, "a\0", "b"), null);
  assert.equal(replacement(path, "a\n".repeat(1000), "b\n".repeat(1000)), null);
  assert.equal(codePreview(path, "x".repeat(100001)), null);
  assert.equal(codePreview("bad\npath", "a"), null);
  assert.deepEqual(
    toolFileChanges("MultiEdit", {
      file_path: path,
      edits: [{ old_string: "a", new_string: "b" }, {}],
    }),
    {},
  );
  assert.deepEqual(toolFileChanges("edit", {}, null), {});
});
test("shared preview budget bounds multi-file rows and huge individual lines", () => {
  const files = [codePreview("a.js", "x\n".repeat(220)), codePreview("b.js", "tail")];
  const preview = changePreview(files, 8);
  assert.equal(preview.files.length, 1);
  assert.equal(preview.files[0].rows.length, 7);
  assert.equal(preview.truncated, true);
  assert.equal(changePreview(files, 400).truncated, false);
  const long = changePreview([codePreview("a.js", "x".repeat(5000))], 8);
  assert.equal(long.files[0].rows[0].text.length, 4000);
  assert.equal(long.truncated, true);
});

test("Codex full-content additions/deletions and move_path suffix preserve native semantics", () => {
  const changes = [
    { path: "new.ts", kind: { type: "add" }, diff: "const a = 1;\n" },
    { path: "old.ts", kind: { type: "delete" }, diff: "old" },
    {
      path,
      kind: { type: "update", move_path: "renamed.ts" },
      diff: patch + "\n\nMoved to: renamed.ts",
    },
  ];
  const files = normalizeCodex({
    turns: [{ items: [{ type: "fileChange", changes, status: "completed" }] }],
  }).messages[0].fileChanges;
  assert.deepEqual(
    files.map((f) => f.operation),
    ["create", "delete", "rename"],
  );
  assert.equal(files[0].rows[0].newLine, 1);
  assert.equal(files[1].rows[0].oldLine, 1);
  assert.equal(files[1].rows[1].annotation, "oldNoNewline");
  assert.equal(files[2].movePath, "renamed.ts");
});

test("Codex structured tool exit failures do not claim successful edits", () => {
  const records = [
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "p",
        name: "apply_patch",
        input: command,
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "p",
        output: JSON.stringify({ output: "Patch failed", metadata: { exit_code: 1 } }),
      },
    },
  ];
  assert.equal(normalizeCodexRecords(records).messages[0].status, "failed");
});
