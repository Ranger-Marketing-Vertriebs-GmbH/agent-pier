// What the owner confirms before a local (stdio) server is saved: the exact command
// line and the names of its environment settings, never their values.

const plain = /^[A-Za-z0-9_@%+=:,./~^-]+$/;

/** One word as a POSIX shell would read it back: quoted when it is not plain. */
export const shellWord = (value) =>
  plain.test(value) ? value : `'${String(value).replaceAll("'", `'\\''`)}'`;

/** The arguments the save sends: one per row, empty rows dropped (saveValues). */
export const commandArguments = (rows = []) =>
  rows.flatMap((row) => String(row ?? "").split("\n")).filter((arg) => arg !== "");

/** The full command line: the command, then every argument, each quoted as needed. */
export const commandLine = (command, rows) =>
  [String(command ?? "").trim(), ...commandArguments(rows)]
    .filter((word, index) => index > 0 || word !== "")
    .map(shellWord)
    .join(" ");

/** The names of the environment settings the save sends or keeps; values stay out. */
export const environmentNames = (rows = []) => [
  ...new Set(
    rows
      .filter((row) => row.name?.trim() && !row.removed && (row.value || row.stored))
      .map((row) => row.name.trim()),
  ),
];
