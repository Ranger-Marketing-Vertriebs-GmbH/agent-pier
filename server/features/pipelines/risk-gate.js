import { serverMessages } from "../../lib/i18n/de.js";
import { createHash } from "node:crypto";
import { ruleMatcher } from "./risk-rules.js";
import { addedDependencies, dependencyManifest } from "./risk-dependencies.js";
import { currentAttempt } from "./graph-navigation.js";

// The deterministic risk gate. When a stage concludes, and again right before anything
// is pushed, AgentPier matches every path the run changed since its base against the
// project's risk rules and lists the spec's product decisions. An item the owner has
// not approved yet parks the stage at a gate (`risk-gate`) before its verification,
// approval, pull request or next stage, whatever the verdicts say. The owner's
// approval covers exactly the listed items: a later check gates again only for a new
// path, dependency, submodule commit or product decision.
export const RISK_ITEMS = 200;
const DECISIONS = 50;

const digest = (text) => createHash("sha256").update(text).digest("hex");

export function riskKey(item) {
  if (item.assumption !== undefined) return `assumption:${digest(item.text)}`;
  if (item.submodule !== undefined) return `submodule:${item.path}:${item.submodule}`;
  if (item.dependency !== undefined) return `dependency:${item.path}:${item.dependency}`;
  return `path:${item.path}`;
}

/**
 * Matched paths, added dependencies and moved submodules of a list of changes, in diff
 * order. `readFile(side, path)` resolves a file's text, or null when it does not exist.
 */
export async function riskItems(changes, rules, readFile) {
  const match = ruleMatcher(rules.globs);
  const read = async (side, path) => {
    try {
      return await readFile(side, path);
    } catch {
      return undefined;
    }
  };
  const items = [];
  for (const change of changes) {
    const sides = change.from
      ? [
          { path: change.from, renamedTo: change.path },
          { path: change.path, renamedFrom: change.from },
        ]
      : [{ path: change.path }];
    for (const side of sides) {
      const rule = match(side.path);
      if (rule) items.push({ ...side, status: change.status, rule });
    }
    if (!rules.newDependency) continue;
    if (change.submodule)
      items.push({
        path: change.path,
        status: change.status,
        submodule: change.submodule,
      });
    else if (change.status !== "D" && dependencyManifest(change.path)) {
      const [before, after] = await Promise.all([
        change.status === "A" ? null : read("from", change.from || change.path),
        read("to", change.path),
      ]);
      for (const dependency of addedDependencies(change.path, before, after ?? undefined))
        items.push({ path: change.path, status: change.status, dependency });
    }
  }
  const seen = new Set();
  return items.filter((item) => {
    const key = riskKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Assumptions of the run's spec that settle product behaviour: the owner confirms each
// one once, also after a spec revision that keeps its text.
export const assumptionItems = (run) =>
  (run.spec?.assumptions || [])
    .filter((a) => a.productDecision)
    .map((a) => ({ assumption: a.id, text: a.text }));

const rulesOf = (engine, run) =>
  engine.definitions.riskRules
    ? engine.definitions.riskRules(run.projectId)
    : { globs: [], newDependency: false, enabled: true };

async function unapproved(engine, run, rules, to) {
  const from = run.workspace.baseSha;
  const { changes } = await engine.workspace.changes({
    workspace: run.workspace,
    from,
    to,
  });
  const items = [
    ...assumptionItems(run),
    ...(await riskItems(changes, rules, (side, path) =>
      engine.workspace.fileAt({
        workspace: run.workspace,
        sha: side === "from" ? from : to,
        path,
      }),
    )),
  ];
  const approved = new Set(run.risk?.approved || []);
  return items.filter((item) => !approved.has(riskKey(item)));
}

// Whether the workspace can tell the gate what changed; test doubles may not.
const checkable = (engine, run) =>
  Boolean(run.workspace && engine.workspace.changes && engine.workspace.fileAt);

/**
 * Parks the stage at the risk gate when the run's changes up to `sha` (by default the
 * stage's checkpoint) hold risky paths, dependencies or product decisions the owner
 * has not approved. Returns true when it parked. `resume` says what an approval
 * continues: the stage's conclusion, its advance (a pull request) or the publication
 * of a completed run. A check that fails parks too: the owner may approve continuing
 * without it, for this exact commit.
 */
export async function riskGate(engine, run, node, park, { sha, resume } = {}) {
  const attempt = currentAttempt(run);
  const to = sha || attempt?.endSha;
  if (!to || !checkable(engine, run)) return false;
  const rules = rulesOf(engine, run);
  if (rules.enabled === false) return false;
  if ((run.risk?.decisions || []).some((d) => d.sha === to && d.error)) return false;
  let items, error;
  try {
    items = await unapproved(engine, run, rules, to);
  } catch (failure) {
    engine.recordError(failure);
    error = true;
  }
  if (!error && !items.length) return false;
  node.riskGate = {
    at: engine.now(),
    attemptId: attempt?.attemptId ?? null,
    sha: to,
    ...(resume ? { resume } : {}),
    ...(error
      ? { error: true }
      : { items: items.slice(0, RISK_ITEMS), total: items.length }),
  };
  park(
    engine,
    run,
    node,
    "risk-gate",
    error ? serverMessages.pipelines.riskCheckFailed : "",
  );
  return true;
}

/**
 * Before anything is pushed: commits what the worktree holds now and checks the run
 * up to that commit, which is the commit the push publishes. Resolves the checked
 * sha, or `{ parked: true }` when the risk gate stopped the run.
 */
export async function publishCheck(engine, run, node, park, resume) {
  if (!engine.workspace.checkpoint || !checkable(engine, run)) return {};
  const { sha } = await engine.workspace.checkpoint({
    workspace: run.workspace,
    run,
    node,
    attempt: currentAttempt(run),
  });
  if (await riskGate(engine, run, node, park, { sha, resume })) return { parked: true };
  return { sha };
}

/**
 * The owner approves the risky changes the gate listed. The approval is recorded on the
 * run with every listed path and dependency, so later stages gate only for new ones.
 * The full list of an over-long gate is matched again on the next conclusion.
 */
export function approveRisk(engine, run, node) {
  const gate = node.riskGate;
  const items = gate?.items || [];
  const at = engine.now();
  run.risk = {
    approved: [...new Set([...(run.risk?.approved || []), ...items.map(riskKey)])],
    decisions: [
      ...(run.risk?.decisions || []),
      {
        at,
        nodeId: node.id,
        attemptId: gate?.attemptId ?? null,
        sha: gate?.sha ?? null,
        decision: "approved",
        ...(gate?.error
          ? { error: true }
          : { items, total: gate?.total ?? items.length }),
      },
    ].slice(-DECISIONS),
  };
  delete node.riskGate;
  node.gateDecision = "risk-approved";
  node.gateDecidedAt = at;
  return run.risk.decisions.at(-1);
}
