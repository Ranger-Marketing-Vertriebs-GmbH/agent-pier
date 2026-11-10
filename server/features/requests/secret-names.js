// Paths and words that name secrets or credentials: any argument that matches
// keeps a command asking.
export const secretWords =
  /(^|[/=\s])\.env(\.|$|\/)|\.ssh(\/|$)|id_(rsa|dsa|ecdsa|ed25519)|\.(pem|key|p12|pfx|keystore|jks|kdbx)$|credential|\.netrc|\.npmrc|\.pypirc|\.aws(\/|$)|\.gnupg|\.kube(\/|$)|secret|token|passw|auth\.json|\.pgpass|keychain|\.envrc|\.docker\/config\.json|\.config\/(gh\/hosts\.yml|sops)|\.\w*_history/i;

/** Whether a command's words (or a tool's path) name a secret or credentials file. */
export const touchesSecret = (words) => words.some((word) => secretWords.test(word));

// The file and folder names `secretWords` protects, as shell patterns: what a glob
// such as `id_*`, `*.k?y` or `cred*` must not be able to match. Key stores are
// known by their ending; the words (`secret`, `token`, …) by the names such files
// usually carry, alone or with the ending of a data or configuration file. A name
// that only contains such a word (`src/token-parser.js`) is not listed: every
// `*.js` could match it, and it is no credentials file. Dot files and folders
// (`.env`, `.ssh`, `.aws`, …) need no entry; a pattern for any dot name asks
// (shell-expansion.js).
const keyEndings = ["pem", "key", "p12", "pfx", "keystore", "jks", "kdbx", "keychain"];
const keyNames = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
const words = [
  "credential",
  "credentials",
  "secret",
  "secrets",
  "token",
  "tokens",
  "password",
  "passwords",
  "passwd",
  "keychain",
];
const dataEndings = [
  "json",
  "yml",
  "yaml",
  "toml",
  "txt",
  "ini",
  "conf",
  "cfg",
  "xml",
  "csv",
  "properties",
];
export const secretShapes = Object.freeze([
  ...keyEndings.map((ending) => `*.${ending}`),
  "*.keychain-db",
  ...keyNames.flatMap((name) => [name, `${name}.pub`]),
  ...words,
  "auth.json",
  ...words.flatMap((word) => dataEndings.map((ending) => `${word}.${ending}`)),
]);

// The words `secretWords` finds anywhere in a name, each with the number of its
// characters a pattern must write out to aim at such a file (`s?cret.txt`,
// `*oken`): three, and for `auth.json` more than its ending, which `*.json` has.
const written = 3;
export const secretFragments = Object.freeze(
  [
    "credential",
    "secret",
    "token",
    "passw",
    "keychain",
    ...keyNames,
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".gnupg",
    ".pgpass",
  ]
    .map((word) => [word, written])
    .concat([["auth.json", 6]]),
);

// Protected files known by more than one path part; a pattern for a part of them
// (`.config/g?/hosts.yml`) is judged against the whole.
export const secretPaths = Object.freeze(
  [".docker/config.json", ".config/sops", ".config/gh/hosts.yml"].map((name) =>
    name.split("/"),
  ),
);

/** The endings of key stores, as a name carries them. */
export const secretEndings = Object.freeze(keyEndings.map((ending) => `.${ending}`));
