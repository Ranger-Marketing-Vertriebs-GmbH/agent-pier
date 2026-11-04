import { anchorAt } from "../../../server/features/changes/review-anchor.js";
import { parseGitDiff } from "../../../server/features/changes/diff-parse.js";
import { galleryCopy as copy } from "../../lib/i18n/messages/gallery.js";

// Sample data for the gallery: everything is local, nothing reaches the API.
export const noop = () => {};

export const options = () => [
  { value: "a", label: copy.sample.optionA },
  { value: "b", label: copy.sample.optionB },
  { value: "c", label: copy.sample.optionC },
  { value: "x", label: copy.sample.optionDisabled, disabled: true },
];

export const pageItems = () =>
  Array.from({ length: 45 }, (_, index) => copy.sample.pageItem(index + 1));

export const detailItems = () => [
  { id: "a", name: copy.sample.optionA },
  { id: "b", name: copy.sample.optionB },
  { id: "c", name: copy.sample.optionC },
];

// A small inline SVG; colours as rgb() since only base.css holds hex literals.
export const sampleImage =
  "data:image/svg+xml," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='320' height='200' viewBox='0 0 320 200'>" +
      "<rect width='320' height='200' fill='rgb(24,25,29)'/>" +
      "<circle cx='160' cy='100' r='56' fill='rgb(244,154,88)'/></svg>",
  );

/** A settings draft (useTabDraft) frozen in one of the save bar's states. */
export function sampleDraft(state) {
  const outcome =
    state === "error"
      ? { status: "error", error: { message: copy.sample.error } }
      : state === "conflict"
        ? { status: "conflict" }
        : state === "partial"
          ? { status: "error", partial: [copy.sample.optionA] }
          : null;
  return {
    dirty: state !== "hidden",
    saving: state === "saving",
    outcome,
    conflicts: [],
    reset: noop,
    reload: noop,
  };
}

/** 600 synthetic SSH accesses for AddPicker: prod/stage/dev × web/db/api/logs × 50. */
export function sshHosts() {
  const projects = { prod: copy.addPicker.global, stage: "api-server", dev: "shop" };
  return Object.entries(projects).flatMap(([env, project], envIndex) =>
    ["web", "db", "api", "logs"].flatMap((role, roleIndex) =>
      Array.from({ length: 50 }, (_, index) => {
        const name = `${env}-${role}-${String(index + 1).padStart(2, "0")}`;
        return {
          id: name,
          name,
          sub: `deploy@10.${envIndex}.${roleIndex}.${index + 1}`,
          group: project,
        };
      }),
    ),
  );
}

/** MCP servers for the AddPicker search sample. */
export const mcpServers = () =>
  [
    "github",
    "filesystem",
    "fetch",
    "postgres",
    "sqlite",
    "slack",
    "sentry",
    "linear",
  ].map((name) => ({ id: name, name, sub: `@modelcontextprotocol/server-${name}` }));

/** An hour of sample load, one point a minute, with ten minutes nobody measured. */
export function historySample(end) {
  return Array.from({ length: 61 }, (_, index) => ({
    t: end - (60 - index) * 60_000,
    first: 20 + 10 * Math.sin(index / 5),
    second: 60 + 3 * Math.cos(index / 7),
    third: 5 + 2 * Math.sin(index / 3),
  })).filter((_, index) => index < 25 || index > 35);
}

/** A deterministic review fixture for DiffReview: parsed git diffs and sample comments. */
const reviewDiff = [
  "diff --git a/server/a.js b/server/a.js",
  "index 1111111..2222222 100644",
  "--- a/server/a.js",
  "+++ b/server/a.js",
  "@@ -10,6 +10,7 @@ export function check(token) {",
  "   const expected = load();",
  "-  if (token === expected) {",
  "+  if (timingSafeEqual(token, expected)) {",
  "     return true;",
  "   }",
  "+  audit(token);",
  "   return false;",
  " }",
  "diff --git a/server/long.js b/server/long.js",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/server/long.js",
  "@@ -0,0 +1,2 @@",
  `+const payload = "${"x".repeat(10000)}";`,
  "+export default payload;",
  "diff --git a/server/big.js b/server/big.js",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/server/big.js",
  "@@ -0,0 +1,450 @@",
  ...Array.from(
    { length: 450 },
    (_, index) => `+export const value${index + 1} = ${index + 1};`,
  ),
].join("\n");

export const reviewFiles = parseGitDiff(reviewDiff);
export const REVIEW_WORKSPACE = "gallery";

const rowIndex = (path, test) =>
  reviewFiles.find((file) => file.path === path).rows.findIndex(test);

function comment(id, path, index, fields) {
  const rows = reviewFiles.find((file) => file.path === path).rows;
  const anchor = anchorAt(rows, index);
  return {
    id,
    workspace: REVIEW_WORKSPACE,
    file: path,
    side: anchor.side,
    line: anchor.line,
    anchor,
    status: "open",
    createdAt: "2026-11-04T09:00:00.000Z",
    updatedAt: "2026-11-04T09:00:00.000Z",
    ...fields,
  };
}

/** One open, one resolved, one outdated, one sent, one past the first page, one on a removed file. */
export function reviewComments() {
  const text = (needle) => (row) => row.text.includes(needle);
  const stale = {
    text: "console.log(token);",
    before: [],
    after: [],
    excerpt: [{ kind: "add", text: "console.log(token);" }],
  };
  const outdated = comment("c-outdated", "server/a.js", 3, {
    body: copy.diff.outdatedBody,
  });
  outdated.anchor = { ...outdated.anchor, ...stale };
  const missing = comment("c-missing", "server/a.js", 3, { body: copy.diff.missingBody });
  return [
    comment("c-open", "server/a.js", rowIndex("server/a.js", text("timingSafeEqual")), {
      body: copy.diff.openBody,
    }),
    comment("c-resolved", "server/a.js", rowIndex("server/a.js", text("return true")), {
      body: copy.diff.resolvedBody,
      status: "resolved",
    }),
    outdated,
    comment("c-sent", "server/a.js", rowIndex("server/a.js", text("audit(token)")), {
      body: copy.diff.sentBody,
      sentIn: 1,
    }),
    comment("c-paged", "server/big.js", rowIndex("server/big.js", text("value430 ")), {
      body: copy.diff.paged,
    }),
    { ...missing, file: "server/removed.js" },
  ];
}
