import { previews as de } from "../../lib/i18n/de/previews.js";
import { previews as en } from "../../lib/i18n/en/previews.js";

const catalogs = { de: de.pages, en: en.pages };

/** The language of a preview page: German when the browser prefers it, else English. */
export function pageLanguage(req) {
  const first = String(req.headers?.["accept-language"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return first.startsWith("de") ? "de" : "en";
}

export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );

const statuses = {
  bounce: 200,
  signIn: 401,
  forbidden: 403,
  idle: 404,
  unreachable: 502,
};

function document(language, title, body, head = "") {
  return `<!DOCTYPE html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
${head}<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1.25rem;line-height:1.5}h1{font-size:1.25rem}</style>
</head>
<body>
<main>
<h1>${title}</h1>
${body}
</main>
</body>
</html>
`;
}

/**
 * A page the preview proxy answers with itself. Every text is escaped; the label comes
 * from an agent and the sign-in URL from the request's host name.
 */
export function previewPage(
  kind,
  { language = "en", label = "", target, signInUrl } = {},
) {
  if (!Object.hasOwn(statuses, kind)) throw new TypeError(`Unknown preview page ${kind}`);
  const copy = catalogs[language] || catalogs.en;
  const text = (value) => `<p>${escapeHtml(value)}</p>`;
  let html;
  if (kind === "bounce")
    // A cross-site navigation carries no SameSite=Strict cookie; navigating again from
    // this page is same-site and does.
    html = document(
      language,
      escapeHtml(copy.bounceTitle),
      `<p><a href="">${escapeHtml(copy.bounceLink)}</a></p>`,
      "<script>location.replace(location.href)</script>\n",
    );
  else if (kind === "signIn")
    html = document(
      language,
      escapeHtml(copy.signInTitle),
      `${text(copy.signInText)}\n<p><a href="${escapeHtml(signInUrl)}">${escapeHtml(copy.signInLink)}</a></p>`,
    );
  else if (kind === "forbidden")
    html = document(language, escapeHtml(copy.forbiddenTitle), text(copy.forbiddenText));
  else if (kind === "idle")
    html = document(language, escapeHtml(copy.idleTitle), text(copy.idleText));
  else
    html = document(
      language,
      escapeHtml(copy.unreachableTitle(target)),
      text(copy.unreachableText(label)),
    );
  return { status: statuses[kind], html };
}

/** The plain refusal a sub-request (fetch, image, script) gets instead of a page. */
export const refusalText = (language) => (catalogs[language] || catalogs.en).unauthorized;
