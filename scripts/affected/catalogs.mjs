// Server message catalogs (server/lib/i18n/de/*.js, en/*.js) are merged into one
// messages object that nearly every server module imports, so through the plain
// graph one changed message would select almost every test. A catalog change
// instead selects the modules that read its namespace (`serverMessages.releases`,
// `messages["releases"]`) or import the catalog directly, the catalog tests that
// import the merged catalogs (parity and wording checks), and what reaches those.

export const serverCatalog = /^server\/lib\/i18n\/(?:de|en)\/[^/]+\.js$/;
// The modules that merge catalogs into one object.
export const catalogHub = /^server\/lib\/i18n\/[^/]+\.js$/;
// Tests that check all catalogs at once rather than one namespace.
export const catalogTest = /(?:i18n|catalog|messages|language)[^/]*\.test\.js$/;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The names a catalog's messages are read under: its exports and the keys the
// merging modules give them (`releases: releaseCopy`).
export function catalogNames(text, hubTexts) {
  const names = new Set();
  for (const match of text.matchAll(/export\s+const\s+([\w$]+)/g)) names.add(match[1]);
  for (const name of [...names])
    for (const hub of hubTexts)
      for (const match of hub.matchAll(
        new RegExp(`([\\w$]+)\\s*:\\s*${escape(name)}\\b`, "g"),
      ))
        names.add(match[1]);
  return names;
}

// Start files for the reachability walk from changed catalog `file`.
export function catalogStarts(graph, file, read) {
  const hubs = [...graph.files].filter((candidate) => catalogHub.test(candidate));
  const names = catalogNames(
    read(file) || "",
    hubs.map((hub) => read(hub) || ""),
  );
  const access = [...names].map(
    (name) => new RegExp(`(?:\\??\\.\\s*|\\[\\s*["'\`])${escape(name)}\\b`),
  );
  const starts = new Set([file]);
  const seen = new Set();
  const visit = (current) => {
    for (const dependent of graph.dependents(current)) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      if (catalogHub.test(dependent)) visit(dependent);
      else if (!graph.files.has(dependent)) continue;
      else if (current === file || catalogTest.test(dependent)) starts.add(dependent);
    }
  };
  visit(file);
  for (const candidate of graph.files) {
    if (starts.has(candidate) || !/\.(?:m?js|jsx)$/.test(candidate)) continue;
    if (catalogHub.test(candidate) || serverCatalog.test(candidate)) continue;
    const text = read(candidate);
    if (text && access.some((pattern) => pattern.test(text))) starts.add(candidate);
  }
  return [...starts];
}
