import { parseDocument, stringify as yaml } from "yaml";
import { stringify as toml } from "smol-toml";
import { problem } from "../../lib/storage.js";
export const repository = "msitarzewski/agency-agents";
export const sourceUrl = `https://github.com/${repository}`;
const excluded = new Set([".github", "examples", "integrations", "scripts"]);
export async function download(url, fetchImpl, signal, limit = 2 * 1024 * 1024) {
  const response = await fetchImpl(url, {
    signal,
    redirect: "error",
    headers: { accept: "application/vnd.github+json", "user-agent": "AgentPier" },
  });
  if (!response.ok)
    throw problem(`Agency Agents download failed (HTTP ${response.status}).`, 502);
  const reader = response.body?.getReader();
  if (!reader) throw problem("Agency Agents returned an empty response.", 502);
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit)
        throw problem("Agency Agents response exceeds the download limit.", 413);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}
export function catalogEntries(tree) {
  if (!Array.isArray(tree.tree) || tree.truncated || tree.tree.length > 10000)
    throw problem("Agency Agents returned an incomplete catalog.", 502);
  return tree.tree
    .filter(
      (item) =>
        item.type === "blob" &&
        (!item.mode || item.mode === "100644") &&
        item.size <= 256 * 1024 &&
        /^[a-z0-9][a-z0-9/-]{1,220}\.md$/.test(item.path) &&
        item.path.includes("/") &&
        !excluded.has(item.path.split("/")[0]) &&
        !/(?:^|\/)readme\.md$/i.test(item.path),
    )
    .map((item) => ({
      id: item.path.slice(0, -3).replaceAll("/", "__"),
      path: item.path,
      category: item.path.split("/")[0],
      name: item.path.split("/").at(-1).replace(/\.md$/, "").replaceAll("-", " "),
    }));
}
export function parseAgent(text) {
  const front = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!front) throw problem("Agency agent is missing YAML metadata.", 422);
  const document = parseDocument(front[1], { uniqueKeys: true });
  if (document.errors.length) throw problem("Agency agent metadata is invalid.", 422);
  let data;
  try {
    data = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw problem("Agency agent metadata aliases are unsupported.", 422);
  }
  if (
    typeof data?.name !== "string" ||
    !data.name.trim() ||
    data.name.length > 200 ||
    typeof data.description !== "string" ||
    !data.description.trim() ||
    data.description.length > 2048 ||
    !front[2].trim()
  )
    throw problem("Agency agent identity or description is invalid.", 422);
  return {
    name: data.name.trim(),
    description: data.description.trim(),
    body: front[2].trim(),
  };
}
export function nativeAgent(tool, agent, source) {
  const body = `${agent.body}\n\nSource: ${source}\nLicense: MIT (see AGENCY-LICENSE.txt).\n`;
  if (tool === "codex")
    return toml({
      name: agent.name,
      description: agent.description,
      developer_instructions: body,
    });
  return `---\n${yaml({ name: agent.name, description: agent.description, ...(tool === "opencode" ? { mode: "subagent" } : { model: "inherit" }) })}---\n\n${body}`;
}
