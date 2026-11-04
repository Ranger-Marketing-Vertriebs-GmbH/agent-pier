import test from "node:test";
import assert from "node:assert/strict";
import { parseGitDiff } from "../../server/features/changes/diff-parse.js";
import { anchorAt } from "../../server/features/changes/review-anchor.js";
import {
  combineFeedback,
  formatReviewBatch,
  reviewEntries,
} from "../../server/features/changes/review-batch.js";
import {
  checkFeedback,
  reviewBatch,
  reviewCheck,
} from "../../web/features/pipelines/useRunReview.js";

const diff = [
  "diff --git a/server/a.js b/server/a.js",
  "index 1111111..2222222 100644",
  "--- a/server/a.js",
  "+++ b/server/a.js",
  "@@ -40,3 +40,3 @@ function login() {",
  " const user = load();",
  "-if (pw === user.pw) return ok();",
  "+if (await verify(pw, user.hash)) return ok(); // ✓ prüfen",
  " return fail();",
].join("\n");
const files = parseGitDiff(diff);
const comment = (id, extra = {}) => ({
  id,
  file: "server/a.js",
  workspace: "",
  anchor: anchorAt(files[0].rows, 3),
  body: "Konstante Zeit 🙂",
  status: "open",
  ...extra,
});
const open1 = comment("c1");

test("the byte count matches the server", () => {
  const check = reviewCheck({ freeText: "Bitte prüfen ä", comments: [open1], files });
  assert.equal(
    check.bytes,
    Buffer.byteLength(
      combineFeedback(
        "Bitte prüfen ä",
        formatReviewBatch(reviewEntries([open1], new Map([["", files]]))),
      ),
    ),
  );
  assert.equal(check.open, 1);
  assert.equal(check.fits, true);
  assert.equal(
    reviewCheck({ freeText: "ä".repeat(16385), comments: [], files }).fits,
    false,
  );
  assert.equal(
    reviewCheck({ freeText: "ä".repeat(16384), comments: [], files }).fits,
    true,
  );
});

test("only open comments count and go into the text", () => {
  const check = reviewCheck({
    freeText: "",
    comments: [open1, comment("c2", { status: "resolved" })],
    files,
  });
  assert.equal(check.open, 1);
  assert.match(check.text, /^Review notes \(1\):/);
  assert.match(check.text, /server\/a\.js:41\n/);
});

test("without the diff the comments count as outdated, as the server sends them", () => {
  const check = reviewCheck({ freeText: "Fix", comments: [open1], files: null });
  assert.match(check.text, /^Fix\n\nReview notes \(1\):/);
  assert.match(check.text, /\(outdated\)/);
});

test("without open comments the free text goes as typed", () => {
  const check = reviewCheck({ freeText: "  fix it \n", comments: [], files });
  assert.deepEqual(check, { open: 0, text: "  fix it \n", bytes: 10, fits: true });
});

test("feedback and comments above the limit do not fit", () => {
  const check = reviewCheck({
    freeText: "ö".repeat(16000),
    comments: [open1, comment("c3", { body: "ü".repeat(400) })],
    files,
  });
  assert.ok(check.text.length < 32768, "under the limit in characters");
  assert.equal(check.fits, false);
});

test("one batch serves every typed text", () => {
  const batch = reviewBatch([open1], files);
  assert.equal(batch.open, 1);
  for (const freeText of ["", "Bitte prüfen", "ä".repeat(100)])
    assert.deepEqual(
      checkFeedback(batch, freeText),
      reviewCheck({ freeText, comments: [open1], files }),
    );
  assert.deepEqual(reviewBatch([], files), { open: 0, batch: null });
  assert.equal(checkFeedback(reviewBatch([], files), "typed").text, "typed");
});
