import test from "node:test";
import assert from "node:assert/strict";
import {
  findMentions,
  mentionMatches,
  mentionLimit,
  mentionQuery,
  treeMentions,
} from "../../server/features/assistants/member-mentions.js";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

const team = [
  { id: "net", name: "Network Architect" },
  { id: "max", name: "Max" },
  { id: "ops", name: "Max Ops" },
  { id: "doc", name: "Ärztin" },
];
const ids = (text, members = team) => findMentions(text, members).map((m) => m.memberId);

test("a mention resolves names with spaces, in any case, at word boundaries", () => {
  assert.deepEqual(ids("@Network Architect trag den NAS ein"), ["net"]);
  assert.deepEqual(ids("@network architect, bitte"), ["net"]);
  assert.deepEqual(ids("@NETWORK   ARCHITECT now"), ["net"]);
  assert.deepEqual(ids("frag @ärztin und @MAX."), ["doc", "max"]);
  const [m] = findMentions("Hi @Network Architect!", team);
  assert.equal(m.start, 3);
  assert.equal(m.end, 21);
  assert.equal(m.ambiguous, false);
});

test("the longest name wins and a prefix collision picks the right member", () => {
  assert.deepEqual(ids("@Max Ops deploy it"), ["ops"]);
  assert.deepEqual(ids("@Max deploy it"), ["max"]);
  // "Max Opsy" is not "Max Ops": the shorter name at a word boundary wins.
  assert.deepEqual(ids("@Max Opsy is new"), ["max"]);
  assert.deepEqual(ids("@Maxi deploy"), []);
  assert.deepEqual(ids("@Max-Ops"), ["max"]);
});

test("unknown, embedded and ambiguous mentions resolve to nobody", () => {
  assert.deepEqual(ids("@Nobody here"), []);
  assert.deepEqual(ids("write to max@example.org"), []);
  assert.deepEqual(ids("/ask@Max hello"), []);
  for (const before of ["/", ".", ":", "=", "_", "-", "\\", "[", ">", "@", "`", "~"])
    assert.deepEqual(ids(`${before}@Max hello`), [], before);
  assert.deepEqual(ids("(@Max) hello"), ["max"]);
  assert.deepEqual(ids("@ Max hello"), []);
  assert.deepEqual(ids("@Max", []), []);
  assert.deepEqual(ids("no mention at all"), []);
  const twins = [
    { id: "a", name: "Scout" },
    { id: "b", name: "scout" },
  ];
  const [m] = findMentions("@Scout go", twins);
  assert.equal(m.ambiguous, true);
  assert.equal(m.memberId, null);
  assert.deepEqual(m.memberIds, ["a", "b"]);
  // Names are taken literally, never as patterns.
  assert.deepEqual(ids("@a.b go", [{ id: "x", name: "a+b" }]), []);
  assert.deepEqual(ids("@a+b go", [{ id: "x", name: "a+b" }]), ["x"]);
});

test("Telegram text is parsed the same way", () => {
  const text = "Morgen!\n@network architect trag den neuen NAS ein\n/start@agentpier_bot";
  assert.deepEqual(ids(text), ["net"]);
  assert.deepEqual(ids("@Max Ops\n@Max"), ["ops", "max"]);
});

const tree = (text) =>
  fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
const shown = (text) =>
  treeMentions(tree(text), team).flatMap(({ node, mentions }) =>
    mentions.map((m) => node.value.slice(m.start, m.end)),
  );

test("mentions count only in the owner's own text of a Markdown message", () => {
  assert.deepEqual(shown("Hi @max ops, und **@Max**.\n\n- @Network Architect"), [
    "@max ops",
    "@Max",
    "@Network Architect",
  ]);
  for (const text of [
    "```\n@Max\n```",
    "    @Max indented",
    "> @Max quoted",
    "`@Max`",
    "[@Max](https://example.com)",
    "https://example.com/@Max",
    "www.example.com/@Max",
    "max@Max.example",
    "![@Max](x.png)",
    "<div>\n@Max\n</div>",
  ])
    assert.deepEqual(shown(text), [], text);
  // Each entry names its paragraph, heading or table cell.
  const [entry] = treeMentions(tree("# Plan\n\nfirst @Max then"), team);
  assert.equal(entry.block.type, "paragraph");
  assert.equal(entry.parent, entry.block);
  const many = treeMentions(tree("@Max ".repeat(50)), team);
  assert.equal(many.flatMap((e) => e.mentions).length, mentionLimit);
});

test("the composer finds the typed query and ranks matching members", () => {
  assert.deepEqual(mentionQuery("Hi @Net", 7), { start: 3, query: "Net" });
  assert.deepEqual(mentionQuery("@Network Ar", 11), { start: 0, query: "Network Ar" });
  assert.deepEqual(mentionQuery("@", 1), { start: 0, query: "" });
  assert.equal(mentionQuery("mail@ex", 7), null);
  assert.equal(mentionQuery("@Max\nnext", 9), null);
  assert.equal(mentionQuery("@Max  trag", 10), null);
  assert.equal(mentionQuery("no at", 5), null);
  assert.deepEqual(
    mentionMatches("max", team).map((m) => m.id),
    ["max", "ops"],
  );
  assert.deepEqual(
    mentionMatches("arch", team).map((m) => m.id),
    ["net"],
  );
  assert.deepEqual(
    mentionMatches("", team).map((m) => m.id),
    ["doc", "max", "ops", "net"],
  );
  assert.deepEqual(mentionMatches("zzz", team), []);
});
