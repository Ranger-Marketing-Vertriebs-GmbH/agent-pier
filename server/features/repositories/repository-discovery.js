import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

const component = /^[A-Za-z0-9_.-]+$/;
export function validRepositoryComponent(value) {
  return (
    typeof value === "string" &&
    value.length <= 200 &&
    component.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

// Use only API paths constructed here. Neither Link nor clone_url returned by
// an upstream server is allowed to choose where a saved token is sent.
export async function discoverAccessibleRepositories({ host, token, fetchImpl, signal }) {
  const base =
    host === "https://github.com" ? "https://api.github.com" : `${host}/api/v3`;
  const repositories = new Map();
  const organizations = new Set();
  let truncated = false;
  try {
    for (let page = 1; page <= 10; page++) {
      const url = new URL(`${base}/user/repos`);
      url.search = new URLSearchParams({
        per_page: "100",
        page: String(page),
        sort: "full_name",
        direction: "asc",
        affiliation: "owner,collaborator,organization_member",
      }).toString();
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "AgentPier",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401)
          throw problem(serverMessages.repositories.githubAuthenticationFailed, 400);
        if (response.status === 403)
          throw problem(serverMessages.repositories.githubAccessDenied, 400);
        if (response.status === 429)
          throw problem(serverMessages.repositories.githubRateLimited, 429);
        throw problem(serverMessages.repositories.githubListFailed, 502);
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024)
          throw problem(serverMessages.repositories.githubResponseTooLarge, 502);
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!Array.isArray(data) || data.length > 100)
        throw problem(serverMessages.repositories.invalidGithubRepositoryList, 502);
      for (const item of data) {
        const owner = item?.owner?.login;
        if (!validRepositoryComponent(owner) || !validRepositoryComponent(item?.name))
          continue;
        const fullName = `${owner}/${item.name}`;
        if (item.owner.type === "Organization") organizations.add(owner);
        repositories.set(fullName.toLowerCase(), {
          id: String(item.id ?? fullName),
          name: item.name,
          fullName,
          owner,
          private: item.private === true,
          url: `${host}/${owner}/${item.name}.git`,
        });
      }
      if (data.length < 100) break;
      if (page === 10) truncated = true;
    }
    return {
      repositories: [...repositories.values()],
      organizations: [...organizations]
        .sort((a, b) => a.localeCompare(b))
        .map((login) => ({ login })),
      truncated,
    };
  } catch (error) {
    if (error.status) throw error;
    if (signal.aborted) throw problem(serverMessages.repositories.searchCancelled, 504);
    throw problem(serverMessages.repositories.githubConnectionFailed, 502);
  }
}
