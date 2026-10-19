import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

// Risk rules of a registered project: path globs whose change needs the owner's
// approval, and whether an added dependency does. They live in AgentPier's data
// directory beside the verification steps; no agent, verdict or worktree file can
// change them.
export const RISK_GLOB_LIMIT = 100;
const GLOB_LENGTH = 200;

// Offered for every project until the owner saves its own rules.
export const DEFAULT_RISK = Object.freeze({
  globs: Object.freeze([
    // Package manifests and lockfiles
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
    "requirements*.txt",
    "Pipfile",
    "Pipfile.lock",
    "pyproject.toml",
    "poetry.lock",
    "uv.lock",
    "go.mod",
    "go.sum",
    "Cargo.toml",
    "Cargo.lock",
    "Gemfile",
    "Gemfile.lock",
    "composer.json",
    "composer.lock",
    // Submodules bring in third-party code
    ".gitmodules",
    // CI, build, deploy and hosting
    "/.github/**",
    "/.gitlab-ci.yml",
    "/.circleci/**",
    "Jenkinsfile",
    "Dockerfile*",
    "docker-compose*",
    "Makefile",
    "/scripts/**",
    "/deploy/**",
    "/infra/**",
    "*.tf",
    "vercel.json",
    "netlify.toml",
    "fly.toml",
    "Procfile",
    // Migrations and data
    "migrations/**",
    "*.sql",
    // Authentication, permissions, payments, storage rules and e-mail
    "auth/**",
    "permissions/**",
    "payments/**",
    "billing/**",
    "*.rules",
    "email/**",
    "mail/**",
  ]),
  newDependency: true,
  enabled: true,
});

export const defaultRisk = () => ({
  globs: [...DEFAULT_RISK.globs],
  newDependency: DEFAULT_RISK.newDependency,
  enabled: true,
});

// At most one `{…}` group of at most 10 alternatives, and at most 10 wildcards.
function boundedGlob(glob) {
  const opens = glob.split("{").length - 1,
    closes = glob.split("}").length - 1;
  if (opens !== closes || opens > 1) return false;
  if (opens) {
    const open = glob.indexOf("{"),
      close = glob.indexOf("}");
    if (close < open || glob.slice(open + 1, close).split(",").length > 10) return false;
  }
  return (glob.match(/[*?]/g) || []).length <= 10;
}

export function validateRisk(body) {
  if (
    !body ||
    !Array.isArray(body.globs) ||
    body.globs.length > RISK_GLOB_LIMIT ||
    typeof body.newDependency !== "boolean" ||
    (body.enabled !== undefined && typeof body.enabled !== "boolean")
  )
    throw problem(serverMessages.pipelineProfiles.invalidRiskRules);
  const globs = [];
  for (const value of body.globs) {
    const glob = typeof value === "string" ? value.trim() : "";
    if (
      !glob ||
      glob.length > GLOB_LENGTH ||
      /[\x00-\x1f\x7f\\]/.test(glob) ||
      glob === "/" ||
      glob.split("/").some((part) => part === "." || part === "..") ||
      !boundedGlob(glob)
    )
      throw problem(serverMessages.pipelineProfiles.invalidRiskGlob(String(value)));
    if (!globs.includes(glob)) globs.push(glob);
  }
  // A gate the owner turned off checks nothing for this project.
  return { globs, newDependency: body.newDependency, enabled: body.enabled !== false };
}

// A glob part within one path segment: `*` matches any run of characters, `?` one.
// It is split at its stars into literal chunks; matching takes the first chunk as the
// prefix, the last as the suffix and every chunk between at its leftmost place, which
// is exact for this syntax and needs no backtracking.
function segmentMatcher(pattern) {
  const parts = pattern.replace(/\*+/g, "*").split("*");
  const at = (text, index, chunk) => {
    for (let k = 0; k < chunk.length; k++)
      if (chunk[k] !== "?" && chunk[k] !== text[index + k]) return false;
    return true;
  };
  if (parts.length === 1)
    return (text) => text.length === pattern.length && at(text, 0, pattern);
  const first = parts[0],
    last = parts.at(-1),
    middle = parts.slice(1, -1).filter(Boolean);
  return (text) => {
    const end = text.length - last.length;
    if (end < first.length || !at(text, 0, first) || !at(text, end, last)) return false;
    let position = first.length;
    for (const chunk of middle) {
      let found = -1;
      for (let i = position; i + chunk.length <= end; i++)
        if (at(text, i, chunk)) {
          found = i;
          break;
        }
      if (found < 0) return false;
      position = found + chunk.length;
    }
    return true;
  };
}

// `{a,b}` alternatives: validation allows at most one group.
function expand(pattern) {
  const open = pattern.indexOf("{"),
    close = open < 0 ? -1 : pattern.indexOf("}", open);
  if (close < 0) return [pattern];
  return pattern
    .slice(open + 1, close)
    .split(",")
    .map((part) => `${pattern.slice(0, open)}${part}${pattern.slice(close + 1)}`);
}

// One alternative as path segments: `**` as a whole segment spans any number of
// folders (also none); a pattern that is not anchored starts with one.
function alternativeMatcher(pattern, anchored) {
  const segments = pattern.split("/").filter(Boolean);
  const steps = [
    ...(anchored ? [] : ["**"]),
    ...segments.map((segment) => (segment === "**" ? "**" : segmentMatcher(segment))),
  ];
  return (parts) => {
    // reach[j]: steps[i..] match parts[j..]; filled from the last step backwards.
    let reach = new Array(parts.length + 1).fill(false);
    reach[parts.length] = true;
    for (let i = steps.length - 1; i >= 0; i--) {
      const next = new Array(parts.length + 1).fill(false);
      for (let j = parts.length; j >= 0; j--)
        next[j] =
          steps[i] === "**"
            ? reach[j] || (j < parts.length && next[j + 1])
            : j < parts.length && reach[j + 1] && steps[i](parts[j]);
      reach = next;
    }
    return reach[0];
  };
}

/**
 * A risk glob as a case-insensitive test of repository-relative paths. A glob that
 * starts with `/` is anchored at the repository root; any other glob matches at any
 * depth, so `auth/**` covers `src/auth/token.js` and `package.json` every
 * package.json. A trailing `/` means everything below. The test runs in time
 * proportional to the path and pattern lengths, whatever the pattern.
 */
export function globMatcher(glob) {
  const anchored = glob.startsWith("/");
  let pattern = (anchored ? glob.slice(1) : glob).toLowerCase();
  if (pattern.endsWith("/")) pattern += "**";
  const alternatives = expand(pattern).map((p) => alternativeMatcher(p, anchored));
  return (file) => {
    const parts = file.toLowerCase().split("/");
    return alternatives.some((matches) => matches(parts));
  };
}

/** Compiles the globs once; the result names the first glob matching a file, or null. */
export function ruleMatcher(globs) {
  const matchers = globs.map((glob) => [glob, globMatcher(glob)]);
  return (file) => matchers.find(([, matches]) => matches(file))?.[0] ?? null;
}
