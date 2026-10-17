import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

const sha = /^[0-9a-f]{40}$/i;
const MAX_RESPONSE = 64 * 1024;

/**
 * One unauthenticated GitHub API read: JSON, or null for 404. Redirects (a renamed
 * repository) are followed only within api.github.com.
 */
async function readApi(path, fetchImpl, signal) {
  let url = new URL(`https://api.github.com${path}`);
  for (let redirects = 0; redirects <= 3; redirects++) {
    let response;
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        signal,
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "AgentPier",
        },
      });
    } catch {
      throw problem(serverMessages.extensions.skillDownloadTimedOut, 502);
    }
    if ([301, 302, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const next = new URL(response.headers.get("location") || "", url);
      if (next.origin !== "https://api.github.com" || next.username || next.password)
        throw problem(serverMessages.extensions.invalidGithubRedirect);
      url = next;
      continue;
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw problem(serverMessages.extensions.skillRefLookupFailed, 502);
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE)
      throw problem(serverMessages.extensions.skillRefLookupFailed, 502);
    try {
      return JSON.parse(text);
    } catch {
      throw problem(serverMessages.extensions.skillRefLookupFailed, 502);
    }
  }
  throw problem(serverMessages.extensions.skillDownloadRedirectLimit);
}

/** The commit an object of a ref names; annotated tags are followed (at most 3 deep). */
async function commitOf(object, repo, fetchImpl, signal) {
  for (let depth = 0; depth < 4; depth++) {
    if (typeof object?.sha !== "string" || !sha.test(object.sha)) break;
    if (object.type === "commit") return object.sha.toLowerCase();
    if (object.type !== "tag") break;
    const tag = await readApi(`${repo}/git/tags/${object.sha}`, fetchImpl, signal);
    object = tag?.object;
  }
  throw problem(serverMessages.extensions.skillRefLookupFailed, 502);
}

/**
 * The kind of `ref` (a full commit SHA, a branch or a tag) and the commit it pins.
 * A name that is both a branch and a tag is refused instead of guessed.
 */
export async function resolveGithubRef(owner, name, ref, fetchImpl, signal) {
  if (sha.test(ref)) {
    const commit = ref.toLowerCase();
    return { ref: commit, refKind: "commit", commit };
  }
  const repo = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const [branch, tag] = await Promise.all(
    ["heads", "tags"].map((kind) =>
      readApi(`${repo}/git/ref/${kind}/${encodeURIComponent(ref)}`, fetchImpl, signal),
    ),
  );
  if (branch && tag) throw problem(serverMessages.extensions.skillRefAmbiguous);
  const found = branch || tag;
  if (!found) throw problem(serverMessages.extensions.skillRefNotFound);
  return {
    ref,
    refKind: branch ? "branch" : "tag",
    commit: await commitOf(found.object, repo, fetchImpl, signal),
  };
}
