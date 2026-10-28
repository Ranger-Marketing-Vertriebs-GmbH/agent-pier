// The email account form without React: preset values, the draft of a new or saved
// account, what blocks saving and the request bodies of POST/PATCH /mail/accounts
// and POST /mail/test. A saved password is never part of the draft: it stays on the
// server, bound to the IMAP and SMTP servers (server/features/mail/mail-account-fields.js).

const presets = {
  gmail: {
    imap: { host: "imap.gmail.com", port: 993, security: "tls" },
    smtp: { host: "smtp.gmail.com", port: 465, security: "tls" },
    // Gmail files every SMTP send in Sent itself.
    saveSent: false,
  },
  generic: {
    imap: { host: "", port: 993, security: "tls" },
    smtp: { host: "", port: 465, security: "tls" },
    saveSent: true,
  },
};

export const mailSecurities = ["tls", "starttls", "none"];
export const mailSides = ["imap", "smtp"];

/** The servers and Sent setting a preset starts with (generic has no hosts). */
export function presetFields(preset) {
  const fields = presets[preset] ?? presets.generic;
  return {
    imap: { ...fields.imap },
    smtp: { ...fields.smtp },
    saveSent: fields.saveSent,
  };
}

const server = (side) => ({
  host: side?.host ?? "",
  port: side?.port ?? "",
  security: side?.security ?? "tls",
});

/** The draft of `account` (a saved view), or of a new account on the generic preset. */
export function formValues(account) {
  if (!account) {
    return {
      preset: "generic",
      name: "",
      address: "",
      displayName: "",
      username: "",
      password: "",
      ...presetFields("generic"),
      allowPlaintext: false,
    };
  }
  const username = account.imap?.username ?? "";
  return {
    preset: account.preset === "gmail" ? "gmail" : "generic",
    name: account.name ?? "",
    address: account.address ?? "",
    displayName: account.displayName ?? "",
    // A username that is the address shows empty: it defaults to the address.
    username: username === account.address ? "" : username,
    password: "",
    imap: server(account.imap),
    smtp: server(account.smtp),
    saveSent: account.saveSent !== false,
    allowPlaintext: account.allowPlaintext === true,
  };
}

/** `values` switched to `preset`: its servers and Sent setting replace the current ones. */
export const withPreset = (values, preset) => ({
  ...values,
  preset,
  ...presetFields(preset),
});

// Ports compare as numbers: "993" typed back over 993 is no change.
const comparable = (values) => ({
  ...values,
  imap: { ...values.imap, port: Number(values.imap.port) },
  smtp: { ...values.smtp, port: Number(values.smtp.port) },
});

export const isDirty = (values, initial) =>
  JSON.stringify(comparable(values)) !== JSON.stringify(comparable(initial));

export const needsPlaintext = (values) =>
  mailSides.some((side) => values[side].security === "none");

const endpoint = (side) => [
  String(side?.host ?? "")
    .trim()
    .toLowerCase(),
  Number(side?.port),
  side?.security,
];

/** Whether `values` reach other IMAP or SMTP servers than the saved `account`. */
export function serversChanged(values, account) {
  if (!account) return false;
  if (values.preset !== (account.preset === "gmail" ? "gmail" : "generic")) return true;
  return mailSides.some(
    (side) =>
      JSON.stringify(endpoint(values[side])) !== JSON.stringify(endpoint(account[side])),
  );
}

/** A new account needs a password; a saved one only when its servers change. */
export const passwordRequired = (values, account) =>
  !account || serversChanged(values, account);

const validPort = (port) => {
  const value = Number(port);
  return Number.isInteger(value) && value >= 1 && value <= 65535;
};

/**
 * Why the draft cannot be saved yet: "incomplete" (a required field is empty or a
 * port invalid), "password" (a password is needed), "plaintext" (a side has no
 * encryption and the owner has not allowed it), or null.
 */
export function saveBlocker(values, account) {
  const filled =
    values.name.trim() &&
    values.address.trim() &&
    mailSides.every((side) => values[side].host.trim() && validPort(values[side].port));
  if (!filled) return "incomplete";
  if (passwordRequired(values, account) && !values.password) return "password";
  if (needsPlaintext(values) && !values.allowPlaintext) return "plaintext";
  return null;
}

/** A pasted app password without whitespace (Google shows it in groups of four). */
export const appPassword = (value) => String(value ?? "").replace(/\s/gu, "");

/** "length" when a typed Gmail app password is not 16 letters long, else null. */
export const appPasswordHint = (values) =>
  values.preset === "gmail" &&
  values.password !== "" &&
  appPassword(values.password).length !== 16
    ? "length"
    : null;

/**
 * The body of POST (create) or PATCH (`editing`) /mail/accounts. One username serves
 * IMAP and SMTP; an empty one lets the server default it to the address. An edit
 * against its `initial` draft leaves the usernames out unless the field or the
 * preset changed, so a stored SMTP username that differs stays. An empty password
 * is left out when editing, so the saved one stays.
 */
export function accountBody(values, { editing = false, initial } = {}) {
  const username = values.username.trim();
  const keepUsernames =
    editing &&
    Boolean(initial) &&
    username === initial.username.trim() &&
    values.preset === initial.preset &&
    // An empty field follows the address: a new address needs it sent again.
    (username !== "" || values.address.trim() === initial.address.trim());
  const side = (name) => ({
    host: values[name].host.trim(),
    port: Number(values[name].port),
    security: values[name].security,
    ...(keepUsernames ? {} : { username }),
  });
  const body = {
    name: values.name.trim(),
    address: values.address.trim(),
    displayName: values.displayName.trim(),
    preset: values.preset,
    imap: side("imap"),
    smtp: side("smtp"),
    allowPlaintext: needsPlaintext(values) && values.allowPlaintext === true,
    saveSent: values.saveSent === true,
  };
  const password =
    values.preset === "gmail" ? appPassword(values.password) : values.password;
  if (password || !editing) body.password = password;
  return body;
}

/** The body of POST /mail/test: a saved account is named, so its password is reused. */
export const testBody = (values, account) =>
  account
    ? {
        accountId: account.id,
        ...accountBody(values, { editing: true, initial: formValues(account) }),
      }
    : accountBody(values);
