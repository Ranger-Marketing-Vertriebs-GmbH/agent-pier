import { buildGraph, codeFile, reachingFiles, syntaxError } from "./import-graph.mjs";
import { browserSpecsFor } from "./browser-map.mjs";
import { catalogHub, catalogStarts, serverCatalog } from "./catalogs.mjs";

// Chooses the tests a change can affect. See scripts/affected-tests.mjs for the
// command line and docs/testing.md for the policy.

export const nodeTest =
  /^tests\/(?:unit|integration|blackbox|property|matrix)\/.+\.test\.js$/;
export const browserSpec = /^tests\/browser\/.+\.spec\.js$/;
// Above this share of a suite, selecting buys little and risks a miss, so the
// whole suite runs.
export const defaultThreshold = 0.6;

// Changes that can affect any test: dependencies, the test runners and their
// configuration, the build, CI, and this selector itself.
export const runEverything = [
  /^package(?:-lock)?\.json$/,
  /^\.npmrc$/,
  /^\.nvmrc$/,
  /^\.node-version$/,
  /^\.github\//,
  /^scripts\/test[^/]*\.mjs$/,
  /^scripts\/affected-tests\.mjs$/,
  /^scripts\/affected\//,
  /^playwright\.config\.js$/,
  /^vite\.config\.js$/,
  /^tests\/helpers\/tmux-reaper\.js$/,
];

// Files no test runs. They select only the tests that name them (for example
// the specs that write docs/screenshots/*.png).
export const inert = [
  /^docs\//,
  /\.md$/,
  /^LICENSE$/,
  /^\.gitignore$/,
  /^\.gitattributes$/,
  /^\.gitleaks\.toml$/,
  /^\.prettierignore$/,
  /^\.prettierrc\.json$/,
];

const matches = (patterns, file) => patterns.some((pattern) => pattern.test(file));

// `changed` is the list of changed paths, or null when the diff could not be
// computed. `source` is the head snapshot: { files, read(file) }.
export function selectAffected({ changed, source, threshold = defaultThreshold }) {
  const nodeTests = source.files.filter((file) => nodeTest.test(file)).sort();
  const browserSpecs = source.files.filter((file) => browserSpec.test(file)).sort();
  const everything = (reasons) => ({
    mode: "all",
    node: nodeTests,
    browser: browserSpecs,
    reasons,
  });
  if (!changed) return everything(["the changed files could not be computed"]);
  if (!changed.length) return { mode: "none", node: [], browser: [], reasons: [] };

  const global = changed.filter((file) => matches(runEverything, file));
  if (global.length)
    return everything(global.map((file) => `${file} affects every test`));

  const present = new Set(source.files);
  const unparsable = changed.filter((file) => {
    if (!present.has(file) || !codeFile.test(file)) return false;
    const text = source.read(file);
    return typeof text !== "string" || syntaxError(file, text) !== null;
  });
  if (unparsable.length)
    return everything(unparsable.map((file) => `${file} could not be parsed`));

  const graph = buildGraph(source.files, source.read);
  const node = new Set();
  const browser = new Set();
  const reasons = [];
  let allBrowser = false;
  const testsOf = new Map();
  for (const file of changed) {
    let count = 0;
    const reach = serverCatalog.test(file)
      ? reachingFiles(graph, catalogStarts(graph, file, source.read), catalogHub)
      : reachingFiles(graph, [file]);
    for (const reached of reach) {
      if (!present.has(reached)) continue;
      if (nodeTest.test(reached)) node.add(reached);
      else if (browserSpec.test(reached)) browser.add(reached);
      else continue;
      count++;
    }
    testsOf.set(file, count);
  }
  const unknown = [];
  for (const file of changed) {
    if (matches(inert, file)) {
      if (testsOf.get(file))
        reasons.push(`${file} is named by ${testsOf.get(file)} test(s)`);
      continue;
    }
    const mapped = browserSpecsFor(file, browserSpecs);
    if (mapped?.all) {
      allBrowser = true;
      reasons.push(`${file} is shared by every page: all browser specs`);
    } else if (mapped) {
      for (const spec of mapped.specs) browser.add(spec);
      if (!mapped.specs.length && file.startsWith("web/")) {
        allBrowser = true;
        reasons.push(
          `${file}: no spec matches feature "${mapped.feature}": all browser specs`,
        );
      } else if (mapped.specs.length)
        reasons.push(
          `${file}: ${mapped.specs.length} spec(s) of feature "${mapped.feature}"`,
        );
    }
    const count = testsOf.get(file);
    const isTest = nodeTest.test(file) || browserSpec.test(file);
    if (count) reasons.push(`${file} reaches ${count} test(s)`);
    else if (!isTest && !mapped?.all && !mapped?.specs.length) unknown.push(file);
  }
  // A file no test imports or names may still run, as a subprocess or through a
  // computed path. Without evidence of its users, run everything.
  if (unknown.length)
    return everything(unknown.map((file) => `no test imports or names ${file}`));

  const result = {
    node: [...node].sort(),
    browser: allBrowser ? browserSpecs : [...browser].sort(),
  };
  const full = { node: nodeTests, browser: browserSpecs };
  for (const suite of ["node", "browser"]) {
    const total = full[suite].length;
    if (result[suite].length < total && result[suite].length > threshold * total) {
      reasons.push(
        `${result[suite].length} of ${total} ${suite} tests selected, above the ` +
          `${Math.round(threshold * 100)}% threshold: all ${suite} tests`,
      );
      result[suite] = full[suite];
    }
  }
  const complete =
    result.node.length === nodeTests.length &&
    result.browser.length === browserSpecs.length;
  const mode = complete
    ? "all"
    : result.node.length || result.browser.length
      ? "selected"
      : "none";
  return { mode, ...result, reasons };
}
