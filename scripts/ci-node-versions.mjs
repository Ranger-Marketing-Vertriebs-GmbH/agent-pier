import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

// Keeps every actions/setup-node in .github/ at or above package.json "engines".
// setup-node takes the runner's cached Node when it satisfies the requested
// version, so a bare major such as `24` once ran CI on 24.19.0, below the floor.
// Allowed values: an exact version within engines, or `>=<floor> <<next major>>`,
// written literally or through a matrix value that is one of those.

const root = path.resolve(import.meta.dirname, "..");
const exact = /^(\d+)\.(\d+)\.(\d+)$/;
const range = /^>=(\d+\.\d+\.\d+)(?:\s+<(\d+))?$/;
const matrixValue = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/;

export function ownEngines(directory = root) {
  return JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).engines
    .node;
}

const parse = (version) => version.match(exact).slice(1).map(Number);
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// "^22.23.4 || >=26.12.1" -> [{ floor: [22, 23, 4], below: 23 }, { floor, below: Infinity }]
function clauses(engines) {
  return engines.split("||").map((part) => {
    const clause = part.trim().match(/^(\^|>=)(\d+\.\d+\.\d+)$/);
    if (!clause) throw new Error(`Unsupported engines clause "${part.trim()}"`);
    const floor = parse(clause[2]);
    return { floor, below: clause[1] === "^" ? floor[0] + 1 : Infinity };
  });
}

const clauseOf = (version, engines) =>
  clauses(engines).find(
    ({ floor, below }) => compare(version, floor) >= 0 && version[0] < below,
  );

// The setup-node range CI uses for one supported major.
export function ciNodeVersion(major, engines = ownEngines()) {
  const clause = clauses(engines).find(({ floor }) => floor[0] === Number(major));
  if (!clause) throw new Error(`Node ${major} is not a major of engines "${engines}"`);
  return `>=${clause.floor.join(".")} <${Number(major) + 1}`;
}

// null when every Node the value can resolve to satisfies engines, else why not.
export function nodeVersionViolation(value, engines = ownEngines()) {
  const text = String(value ?? "").trim();
  const problem = `${JSON.stringify(text)} can resolve outside engines "${engines}"`;
  if (exact.test(text)) return clauseOf(parse(text), engines) ? null : problem;
  const bounds = text.match(range);
  if (!bounds) return problem;
  const lower = parse(bounds[1]);
  const clause = clauseOf(lower, engines);
  const below = bounds[2] === undefined ? Infinity : Number(bounds[2]);
  return clause && below > lower[0] && below <= clause.below ? null : problem;
}

const listed = (value) => (Array.isArray(value) ? value : [value]);

// Every combination a static matrix runs, without include-only additions.
function combinations(matrix) {
  const keys = Object.keys(matrix).filter((key) => !["include", "exclude"].includes(key));
  let combos = keys.length ? [{}] : [];
  for (const key of keys)
    combos = combos.flatMap((combo) =>
      listed(matrix[key]).map((value) => ({ ...combo, [key]: value })),
    );
  const matches = (entry, combo) =>
    Object.keys(entry).every((key) => !(key in combo) || entry[key] === combo[key]);
  const excluded = listed(matrix.exclude ?? []);
  return {
    keys,
    combos: combos.filter((combo) => !excluded.some((entry) => matches(entry, combo))),
    matches,
  };
}

const describe = (combo) =>
  Object.entries(combo)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");

// The values a matrix gives `key`, and combinations that leave it unset.
function matrixValues(matrix, key) {
  if (typeof matrix === "string" || typeof matrix?.include === "string") {
    // A computed matrix: check the JSON fallbacks written into the expression. The
    // computed values come from scripts/affected/ci-plan.mjs, which uses ciNodeVersion.
    const text = typeof matrix === "string" ? matrix : matrix.include;
    const entries = [...text.matchAll(/'(\[[^']*\])'/g)].flatMap((m) => JSON.parse(m[1]));
    return {
      values: entries.filter((entry) => key in entry).map((entry) => entry[key]),
      unset: entries.filter((entry) => !(key in entry)),
    };
  }
  const include = listed(matrix?.include ?? []);
  const { keys, combos, matches } = combinations(matrix ?? {});
  const values = include.filter((entry) => key in entry).map((entry) => entry[key]);
  if (keys.includes(key))
    return { values: [...listed(matrix[key]), ...values], unset: [] };
  const unset = combos.filter(
    (combo) => !include.some((entry) => key in entry && matches(entry, combo)),
  );
  const added = include.filter(
    (entry) => !(key in entry) && !combos.some((combo) => matches(entry, combo)),
  );
  return { values, unset: [...unset, ...added] };
}

function inspectSteps(label, steps, matrix, engines) {
  const found = [];
  for (const step of steps ?? []) {
    if (!String(step?.uses ?? "").startsWith("actions/setup-node@")) continue;
    const value = step.with?.["node-version"];
    if (value === undefined || value === null || value === "") {
      found.push({ problem: `${label}: setup-node step sets no node-version` });
      continue;
    }
    const reference = String(value).trim().match(matrixValue);
    if (!reference) {
      found.push({ problem: prefix(label, nodeVersionViolation(value, engines)) });
      continue;
    }
    if (!matrix) {
      found.push({ problem: `${label}: node-version ${value} names no matrix` });
      continue;
    }
    const { values, unset } = matrixValues(matrix, reference[1]);
    for (const entry of values)
      found.push({ problem: prefix(label, nodeVersionViolation(entry, engines)) });
    for (const combo of unset)
      found.push({
        problem: `${label}: matrix combination ${describe(combo)} sets no ${reference[1]}`,
      });
  }
  return found;
}

const prefix = (label, problem) => problem && `${label}: ${problem}`;

function files(directory) {
  const workflows = path.join(directory, ".github/workflows");
  const actions = path.join(directory, ".github/actions");
  const yaml = (name) => /\.ya?ml$/.test(name);
  return [
    ...(fs.existsSync(workflows)
      ? fs
          .readdirSync(workflows)
          .filter(yaml)
          .map((name) => path.join(workflows, name))
      : []),
    ...(fs.existsSync(actions)
      ? fs
          .readdirSync(actions, { recursive: true })
          .filter((name) => /(?:^|\/)action\.ya?ml$/.test(name))
          .map((name) => path.join(actions, name))
      : []),
  ].sort();
}

// { checked: setup-node steps seen, violations: one line per problem }.
export function inspectNodeVersions(directory = root) {
  const engines = ownEngines(directory);
  let checked = 0;
  const violations = [];
  for (const file of files(directory)) {
    const document = YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
    const name = path.relative(directory, file);
    const groups = document.runs
      ? [["runs", document.runs.steps, null]]
      : Object.entries(document.jobs ?? {}).map(([id, job]) => [
          id,
          job?.steps,
          job?.strategy?.matrix ?? null,
        ]);
    for (const [label, steps, matrix] of groups) {
      checked += listed(steps ?? []).filter((step) =>
        String(step?.uses ?? "").startsWith("actions/setup-node@"),
      ).length;
      for (const { problem } of inspectSteps(label, steps, matrix, engines))
        if (problem) violations.push(`${name}: ${problem}`);
    }
  }
  return { checked, violations };
}

export const findNodeVersionViolations = (directory = root) =>
  inspectNodeVersions(directory).violations;
