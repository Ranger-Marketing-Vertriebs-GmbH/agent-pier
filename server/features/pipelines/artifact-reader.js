import { problem } from "../../lib/storage.js";
import { containedFile } from "./stage-verdict.js";
const deny = new Set([
  ".git",
  ".git-credentials",
  ".claude",
  ".claude.json",
  ".codex",
  ".opencode",
  ".ar-codex",
  ".ar-opencode",
  ".ssh",
  ".aws",
  ".azure",
  ".netrc",
]);
function nodeOf(run, id) {
  const node = run.nodes.find((n) => n.id === id);
  if (!node) throw problem("Pipeline node not found.", 404);
  return node;
}
export function artifactsForNode(run, nodeId) {
  nodeOf(run, nodeId);
  const latest = new Map();
  for (const a of run.executionLog)
    if (a.finishedAt && a.verdict?.artifacts?.length)
      latest.set(a.nodeId, a.verdict.artifacts);
  return { artifacts: [...latest].map(([nodeId, artifacts]) => ({ nodeId, artifacts })) };
}
export function artifactText(run, nodeId, file) {
  nodeOf(run, nodeId);
  const declared = run.executionLog
    .filter((a) => a.nodeId === nodeId && a.finishedAt)
    .some((a) => a.verdict?.artifacts?.some((f) => f.path === file));
  if (!declared) throw problem("Artifact was not declared by this stage.", 404);
  if (file.split("/").some((part) => deny.has(part.toLowerCase())))
    throw problem("Artifact path is private.", 403);
  try {
    const { text, truncated } = containedFile(run.workingDir, file, 2 * 1024 * 1024);
    return { text, truncated };
  } catch (e) {
    if (e.code === "ENOENT") throw problem("Artifact not found.", 404);
    throw e;
  }
}
export async function stageDiff(engine, run, nodeId) {
  nodeOf(run, nodeId);
  const index = run.executionLog.findLastIndex((a) => a.nodeId === nodeId);
  const from = run.executionLog[index]?.baseSha;
  if (!from) return { diff: "", truncated: false };
  const to =
    run.executionLog[index]?.endSha ||
    run.executionLog.slice(index + 1).find((a) => a.baseSha)?.baseSha;
  return engine.workspace.diff({ workspace: run.workspace, from, to });
}
export function verificationLog(engine, run, nodeId, index) {
  const node = nodeOf(run, nodeId);
  if (!Number.isSafeInteger(index) || index < 0)
    throw problem("Invalid verification step.");
  const step = node.verifyResult?.steps?.[index];
  if (!step) throw problem("Verification log not found.", 404);
  return { log: step.logTail || "", truncated: step.logTruncated === true };
}
