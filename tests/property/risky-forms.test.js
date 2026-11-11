import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { shellSegments } from "../../server/features/requests/shell-command.js";
import { riskyForm } from "../../server/features/requests/risky-forms.js";
import { startPlace } from "../../server/features/requests/approval-place.js";

const place = startPlace({ cwd: "/work/repo", roots: ["/work/repo"] });
const risky = (command) => riskyForm(shellSegments(command)[0], place);
const insert = (list, at, item) => {
  const position = Math.min(at, list.length);
  return [...list.slice(0, position), item, ...list.slice(position)];
};
/** Every abbreviation of a long option git would still read as that option. */
const abbreviation = (option, min) =>
  fc
    .tuple(
      fc.integer({ min, max: option.length }),
      fc.constantFrom("", "=x", "=/tmp/out"),
    )
    .map(([end, value]) => option.slice(0, end) + value);

// Per subcommand: arguments a remembered approval covers, and the options that
// turn the command into a form it does not cover.
const forms = {
  branch: {
    plain: ["feature", "-m", "-v", "--list", "-u origin/main", "--no-color"],
    risky: fc.oneof(
      fc.constantFrom("-d", "-D", "-M", "-C", "-f", "-dr", "-vD", "--force"),
      abbreviation("--delete", 5),
    ),
  },
  push: {
    plain: ["origin", "main", "-u", "--tags", "--follow-tags", "--dry-run", "-v"],
    risky: fc.oneof(
      fc.constantFrom("-f", "-d", "-fu", "--force", "--force-with-lease=main", "+main"),
      fc.constantFrom(":old", "--force-if-includes"),
      abbreviation("--delete", 5),
      abbreviation("--mirror", 4),
      abbreviation("--prune", 5),
      abbreviation("--receive-pack", 6),
      abbreviation("--exec", 4),
    ),
  },
  log: {
    plain: ["--oneline", "-5", "--stat", "HEAD", "--show-signature", "-p"],
    risky: abbreviation("--output", 4),
  },
  diff: {
    plain: ["--stat", "HEAD~1", "--cached", "-w", "--output-indicator-new=+"],
    risky: abbreviation("--output", 4),
  },
  fetch: {
    plain: ["origin", "--all", "--prune", "--tags", "--unshallow", "--depth=1"],
    risky: abbreviation("--upload-pack", 5),
  },
  reset: {
    plain: ["HEAD~1", "--soft", "--mixed", "-q", "--", "file.js"],
    risky: abbreviation("--hard", 4),
  },
  clean: {
    plain: ["-n", "-d", "-x", "--dry-run", "src"],
    risky: fc.constantFrom("-f", "-fd", "-xdf", "--force", "-nf"),
  },
};
const form = fc
  .constantFrom(...Object.keys(forms))
  .chain((sub) =>
    fc.tuple(
      fc.constant(sub),
      fc.subarray(forms[sub].plain),
      forms[sub].risky,
      fc.nat({ max: 8 }),
      fc.constantFrom("", "-C sub ", "--no-pager "),
    ),
  );

test("a risky option makes a git command one its remembered program does not cover", () => {
  fc.assert(
    fc.property(form, ([sub, plain, extra, at, before]) => {
      const command = (args) => `git ${before}${sub} ${args.join(" ")}`;
      assert.equal(risky(command(plain)), false, command(plain));
      // Before `--`, where git still reads options.
      const end = plain.indexOf("--");
      const changed = insert(plain, end < 0 ? at : Math.min(at, end), extra);
      assert.equal(risky(command(changed)), true, command(changed));
    }),
    { numRuns: 1000 },
  );
});

test("an option before the subcommand that chooses what git reads or runs is risky", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("log", "status", "fetch origin", "commit -m x", "branch"),
      fc.constantFrom(
        "--exec-path=/tmp/x",
        "--git-dir=/other/.git",
        "--work-tree=/",
        "--config-env=core.pager=X",
        "--namespace=x",
        "--bare",
        "-p",
      ),
      (rest, option) => {
        assert.equal(risky(`git ${rest}`), false);
        assert.equal(risky(`git ${option} ${rest}`), true);
        assert.equal(risky(`git -C sub ${option} ${rest}`), true);
      },
    ),
  );
});

const insideFile = fc.constantFrom("a.txt", "src/b.js", "/work/repo/c", "dist/*.map");
const outsideFile = fc.constantFrom(
  "~/a.txt",
  "~",
  "/etc/hosts",
  "../a.txt",
  "src/../../a",
  "/work/repo-other/x",
  "/tm*/x",
);

test("rm of a tree or of a file outside the project is not covered by its program", () => {
  fc.assert(
    fc.property(
      fc.subarray(["-f", "-i", "-v", "-d"]),
      fc.array(insideFile, { minLength: 1, maxLength: 4 }),
      fc.oneof(
        fc.constantFrom("-r", "-R", "-rf", "-fr", "-Rf", "--recursive", "--recurs"),
        outsideFile,
      ),
      fc.nat({ max: 4 }),
      fc.boolean(),
      (options, files, extra, at, dashes) => {
        const command = (targets) => `rm ${options.join(" ")} ${targets.join(" ")}`;
        assert.equal(risky(command(files)), false, command(files));
        assert.equal(risky(command(insert(files, at, extra))), true);
        // After `--` every word is a file: an option-like name there removes no tree.
        if (dashes && extra.startsWith("/"))
          assert.equal(
            risky(`rm ${options.join(" ")} -- ${files.join(" ")} ${extra}`),
            true,
          );
      },
    ),
    { numRuns: 500 },
  );
});
