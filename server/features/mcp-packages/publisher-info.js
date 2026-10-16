// Who published a package and where its source lives, as the registry states it.
// Shown to the owner as "according to npm/PyPI" and "link given by the publisher,
// not verified"; never trusted for anything else.
const hidden = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const linkLimit = 2048;

/** Trimmed text without control or bidi characters, cut at `cap` with "…"; else null. */
export function plainText(value, cap = 200) {
  if (typeof value !== "string") return null;
  const clean = value.replace(hidden, "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > cap ? `${clean.slice(0, cap - 1)}…` : clean;
}

/** An http(s) link without credentials; npm's git forms become https. Else null. */
export function webLink(value) {
  if (typeof value !== "string") return null;
  let text = value.trim();
  const shorthand = /^github:([\w.-]+\/[\w.-]+)$/.exec(text);
  if (shorthand) text = `https://github.com/${shorthand[1]}`;
  const ssh = /^git@([\w.-]+):(.+)$/.exec(text);
  if (ssh) text = `https://${ssh[1]}/${ssh[2]}`;
  text = text
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "");
  if (text.length > linkLimit) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    return null;
  return url.href.replace(/\/$/, url.pathname === "/" ? "/" : "");
}

/** "Name <mail> (url)" or { name }: the name only. */
const personName = (person) =>
  typeof person === "string"
    ? person.replace(/<[^>]*>|\([^)]*\)/g, "")
    : person && typeof person === "object" && typeof person.name === "string"
      ? person.name
      : "";

export function npmPublisher(packument) {
  const doc = packument && typeof packument === "object" ? packument : {};
  const latest = doc["dist-tags"]?.latest;
  const versions = doc.versions && typeof doc.versions === "object" ? doc.versions : {};
  const info =
    typeof latest === "string" && Object.hasOwn(versions, latest) && versions[latest]
      ? versions[latest]
      : {};
  const people = info.maintainers ?? doc.maintainers;
  const maintainers = Array.isArray(people) ? people.slice(0, 5).map(personName) : [];
  const names = [personName(info.author ?? doc.author), ...maintainers]
    .map((name) => plainText(name, 100))
    .filter(Boolean);
  const repository = info.repository ?? doc.repository;
  return {
    publisher: plainText([...new Set(names)].join(", ")),
    repositoryUrl: webLink(typeof repository === "string" ? repository : repository?.url),
  };
}

const sourceKeys = ["source", "source code", "code", "repository", "homepage"];

export function pypiPublisher(project) {
  const info = project?.info && typeof project.info === "object" ? project.info : {};
  const urls =
    info.project_urls && typeof info.project_urls === "object" ? info.project_urls : {};
  const byKey = new Map(
    Object.entries(urls).map(([key, value]) => [key.trim().toLowerCase(), value]),
  );
  const link =
    sourceKeys.map((key) => webLink(byKey.get(key))).find(Boolean) ??
    webLink(info.home_page);
  return {
    publisher: plainText(info.author) ?? plainText(info.maintainer),
    repositoryUrl: link ?? null,
  };
}
