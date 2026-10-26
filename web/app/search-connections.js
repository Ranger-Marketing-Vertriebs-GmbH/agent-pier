// Connection names for the ⌘K search, loaded once when the search first opens, from
// the list endpoints Zugänge uses. A source that fails stays empty; the rest of the
// index still works. Model access comes from the already loaded /api/state.

const list = (value, key) => {
  const items = Array.isArray(value) ? value : value?.[key];
  return Array.isArray(items) ? items : [];
};
const named = (item, words = []) =>
  item && item.id && item.name ? { id: item.id, name: item.name, words } : null;

/** `{ models, mcp, ssh, secrets, github }` lists of `{ id, name, words }`. */
export async function loadConnectionNames(request, { providerConnections } = {}) {
  const settle = (path) => request(path).catch(() => null);
  const [ssh, mcp, secrets, repositories] = await Promise.all([
    settle("/ssh-accesses"),
    settle("/mcp-servers"),
    settle("/secrets"),
    settle("/repositories"),
  ]);
  const clean = (items) => items.filter(Boolean);
  return {
    models: clean(list(providerConnections, "connections").map((item) => named(item))),
    mcp: clean(list(mcp, "servers").map((item) => named(item))),
    ssh: clean(
      list(ssh, "accesses").map((access) =>
        named(access, [
          access.host,
          access.username && access.host ? `${access.username}@${access.host}` : "",
        ]),
      ),
    ),
    secrets: clean(list(secrets, "secrets").map((item) => named(item))),
    github: clean(list(repositories, "credentials").map((item) => named(item))),
  };
}
