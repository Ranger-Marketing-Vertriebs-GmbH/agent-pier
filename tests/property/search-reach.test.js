import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { shellSegments } from "../../server/features/requests/shell-command.js";
import { defaultSegments } from "../../server/features/requests/cli-approval-defaults.js";
import { rgSearch } from "../../server/features/requests/rg-read-options.js";
import { grepSearch } from "../../server/features/requests/search-reach.js";

const place = { cwd: "/work/repo", roots: ["/work/repo"] };
const allowed = (command) => {
  const segments = shellSegments(command);
  return Boolean(segments && defaultSegments(segments, place).every(Boolean));
};
const insert = (list, at, item) => {
  const position = Math.min(at, list.length);
  return [...list.slice(0, position), item, ...list.slice(position)];
};

const inside = fc.constantFrom("src", ".", "docs/guides", "/work/repo/server", "a.js");
const outside = fc.constantFrom(
  "~",
  "~/Projects",
  "/",
  "/etc",
  "..",
  "../other",
  "src/../..",
  "/work/repo-other",
  "/work",
);
// grep options that leave what is searched alone, some with a value as the next word.
const grepOptions = fc.subarray([
  "-n",
  "-i",
  "-E",
  "-l",
  "-w",
  "-A 2",
  "-B2",
  "-m 5",
  "--include='*.js'",
  "--include '*.js'",
  "--exclude-dir node_modules",
  "--color=never",
  "-H",
]);
const recursion = fc.constantFrom(
  "-r",
  "-R",
  "-rn",
  "-nR",
  "--recursive",
  "--recurs",
  "--dereference-recursive",
  "-d recurse",
  "--directories=recurse",
  "--directories recurse",
);
const pattern = fc.constantFrom("KEY", "''", "'a b'", "-e KEY", "--regexp=KEY", "/api");

test("a recursive grep with a place outside the project always asks", () => {
  fc.assert(
    fc.property(
      grepOptions,
      recursion,
      pattern,
      fc.array(inside, { maxLength: 3 }),
      outside,
      fc.nat({ max: 3 }),
      fc.nat({ max: 12 }),
      (options, recursive, needle, targets, bad, at, where) => {
        const head = insert(options, where, recursive).join(" ");
        const command = (places) => `grep ${head} ${needle} ${places.join(" ")}`;
        assert.equal(allowed(command(targets)), true, command(targets));
        const changed = command(insert(targets, at, bad));
        assert.equal(allowed(changed), false, changed);
      },
    ),
    { numRuns: 500 },
  );
});

test("grep's places are never taken for its pattern or an option's value", () => {
  fc.assert(
    fc.property(
      grepOptions,
      fc.option(recursion, { nil: null }),
      pattern,
      fc.array(fc.constantFrom("src", "/etc", "~", "..", "x y"), { maxLength: 4 }),
      fc.nat({ max: 12 }),
      (options, recursive, needle, targets, where) => {
        const head = recursive ? insert(options, where, recursive) : options;
        const quoted = targets.map((target) => `'${target}'`);
        const words = shellSegments(
          `grep ${head.join(" ")} ${needle} ${quoted.join(" ")}`,
        );
        const read = grepSearch(words[0]);
        assert.equal(read.recursive, recursive !== null);
        assert.deepEqual(read.targets, targets);
      },
    ),
    { numRuns: 500 },
  );
});

// ripgrep options of the default list that leave hidden and ignored files alone.
const rgOptions = fc.subarray([
  "-n",
  "-i",
  "-l",
  "-S",
  "-A 2",
  "-C3",
  "-g '*.js'",
  "--glob='!*.min.js'",
  "-t js",
  "-T md",
  "--max-depth 3",
  "--json",
  "--sort=path",
  "-r x",
]);
const lifting = fc.constantFrom(
  "-u",
  "-uu",
  "-uuu",
  "-nu",
  "-.",
  "--hidden",
  "--unrestricted",
  "--no-ignore",
  "--no-ignore-vcs",
  "--no-ignore-parent",
  "--no-ignore-dot",
  "--no-ignore-global",
  "--no-ignore-exclude",
  "--no-ignore-files",
  "-g '.env*'",
  "--glob='*'",
  "--iglob '.*'",
  "-tsh",
  "--type all",
  "--type-add 'x:.e*'",
);

test("ripgrep with an option that searches hidden or ignored files always asks", () => {
  fc.assert(
    fc.property(
      rgOptions,
      lifting,
      fc.array(inside, { maxLength: 2 }),
      fc.nat({ max: 14 }),
      fc.boolean(),
      (options, lift, targets, where, last) => {
        const tail = `KEY ${targets.join(" ")}`;
        assert.equal(allowed(`rg ${options.join(" ")} ${tail}`), true, options.join(" "));
        const command = last
          ? `rg ${options.join(" ")} ${tail} ${lift}`
          : `rg ${insert(options, where, lift).join(" ")} ${tail}`;
        assert.equal(allowed(command), false, command);
      },
    ),
    { numRuns: 500 },
  );
});

test("ripgrep with a place outside the project always asks", () => {
  fc.assert(
    fc.property(
      rgOptions,
      fc.constantFrom("KEY", "-e KEY", "--regexp=KEY", "--files", "''"),
      fc.array(inside, { maxLength: 3 }),
      outside,
      fc.nat({ max: 3 }),
      (options, needle, targets, bad, at) => {
        const command = (places) =>
          `rg ${options.join(" ")} ${needle} ${places.join(" ")}`;
        assert.equal(allowed(command(targets)), true, command(targets));
        const changed = command(insert(targets, at, bad));
        assert.equal(allowed(changed), false, changed);
        const read = rgSearch(shellSegments(changed)[0]);
        assert.deepEqual(read.targets, insert(targets, at, bad));
      },
    ),
    { numRuns: 500 },
  );
});
