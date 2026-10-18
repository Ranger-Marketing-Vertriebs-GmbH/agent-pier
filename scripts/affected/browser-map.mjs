import path from "node:path";
import { translationLock } from "./catalogs.mjs";

// Browser specs drive the built application and rarely import the code they
// cover, so a change reaches them through its feature name instead. A feature
// folder (web/features/<name>, server/features/<name>) or an HTTP route module
// (server/http/routes/<name>.js) or a message catalog of that name
// (server/lib/i18n/de/<name>.js, web/lib/i18n/messages/<name>.js) selects every spec whose file name contains the
// feature name, its singular, or one of the extra names below, as whole
// dash-separated words.

// Extra spec names per feature, for features whose specs are named differently.
export const featureSpecNames = {
  "adapter-runtime": ["adapter", "endpoint"],
  "assistant-channels": ["telegram"],
  assistants: ["agent"],
  chat: ["claude", "codex-image-delivery", "tool-output", "native-requests"],
  "cli-profiles": ["profiles"],
  dashboard: ["projects", "startup", "navigation"],
  directories: ["launch", "projects"],
  extensions: ["plugins", "codex-marketplace"],
  login: ["startup"],
  models: ["model-control"],
  operations: ["update", "release", "backup", "restore"],
  plugins: ["extensions", "codex-marketplace"],
  "protocol-adapter": ["adapter", "endpoint"],
  "provider-connections": ["endpoint"],
  providers: ["endpoint"],
  repositories: ["repository", "github"],
  requests: ["question", "native-requests"],
  sessions: ["launch", "live", "terminal"],
  settings: ["preferences"],
  speech: ["chat"],
  updates: ["release"],
};

// Changes here can alter every page, so they select every spec.
export const sharedBrowserPaths = [
  /^index\.html$/,
  /^public\//,
  /^web\/(?:app|components|lib|startup|styles)\//,
  /^web\/[^/]+$/,
  /^server\/(?:application|lib)\//,
  /^server\/http\/(?!routes\/)/,
  /^server\/[^/]+$/,
  /^scripts\/(?:startup-plugin|test-server)\.mjs$/,
  /^tests\/helpers\/browser-login-setup\.js$/,
];

const singular = (name) => name.replace(/ies$/, "y").replace(/s$/, "");
const words = (name) => name.split("-");
const containsWords = (spec, name) => {
  const specWords = words(spec);
  const nameWords = words(name);
  for (let start = 0; start + nameWords.length <= specWords.length; start++)
    if (nameWords.every((word, index) => specWords[start + index] === word)) return true;
  return false;
};

// The feature name a path belongs to, or null when it has none.
export function featureOf(file) {
  const catalog = /^(?:server|web)\/lib\/i18n\/(?:de|en|messages)\/([^/]+)\.js$/.exec(
    file,
  );
  if (catalog) return catalog[1];
  const feature = /^(?:web|server)\/features\/([^/]+)\//.exec(file);
  if (feature) return feature[1];
  const route = /^server\/http\/routes\/([^/]+)\.js$/.exec(file);
  return route ? route[1] : null;
}

const specName = (spec) => path.posix.basename(spec).replace(/\.spec\.js$/, "");

export function specsForFeature(feature, specs) {
  const names = [feature, singular(feature), ...(featureSpecNames[feature] || [])];
  let matched = specs.filter((spec) =>
    names.some((name) => containsWords(specName(spec), name)),
  );
  // A route such as "assistant-capabilities" without a spec of its own falls
  // back to its first word, "assistant".
  if (!matched.length && feature.includes("-"))
    matched = specsForFeature(words(feature)[0], specs);
  return matched;
}

// { all: true } when the path is shared by every page, otherwise the specs its
// feature name selects (possibly none), or null when it names no feature.
export function browserSpecsFor(file, specs) {
  // The translation locks are test data; no page reads them.
  if (translationLock.test(file)) return null;
  const feature = featureOf(file);
  const matched = feature ? specsForFeature(feature, specs) : [];
  // A message catalog of a feature with specs selects those; a catalog of shared
  // copy (common, components) falls through to the shared paths below.
  if (matched.length) return { feature, specs: matched };
  if (sharedBrowserPaths.some((pattern) => pattern.test(file))) return { all: true };
  return feature ? { feature, specs: [] } : null;
}
