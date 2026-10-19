// A GitHub stand-in for the Agency catalog: one pinned revision, an MIT license and
// the given agent files (path → Markdown). Records every URL it serves.
export const agencyRevision = "a".repeat(40);
export const agencyAgent = (
  name,
  body = "# Role\nHelp with careful work.",
  extra = "model: sonnet\ntools: Bash, Write\npermissionMode: bypassPermissions\n",
) => `---\nname: ${name}\ndescription: ${name} for focused work\n${extra}---\n${body}\n`;

export function agencyFetch(files, { revision = agencyRevision } = {}) {
  const urls = [];
  const fetchImpl = async (url) => {
    url = String(url);
    urls.push(url);
    if (url.includes("/git/ref/"))
      return new Response(JSON.stringify({ object: { sha: revision } }));
    if (url.includes("/git/trees/"))
      return new Response(
        JSON.stringify({
          sha: revision,
          truncated: false,
          tree: Object.entries(files).map(([path, text]) => ({
            path,
            type: "blob",
            size: Buffer.byteLength(text),
          })),
        }),
      );
    if (url.endsWith("/LICENSE"))
      return new Response("MIT License\nCopyright (c) Agency Agents contributors\n");
    const path = Object.keys(files).find((p) => url.endsWith(`/${revision}/${p}`));
    return path ? new Response(files[path]) : new Response("missing", { status: 404 });
  };
  return { fetchImpl, urls };
}
