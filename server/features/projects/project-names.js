// Short project names. Pure, so the web app's forms suggest and check names with the
// same rules the server applies: a project's folder name is a few words, never the
// prompt or idea it was made for.

/** At most this many characters … */
export const PROJECT_NAME_MAX = 48;
/** … and this many words (split at spaces, hyphens and underscores). */
export const PROJECT_NAME_WORDS = 6;

/**
 * Invisible format and bidi characters, line and paragraph separators, and slash
 * look-alikes: they could disguise a name in the owner's notices.
 */
export const disguisingCharacters = /[\p{Cf}\p{Zl}\p{Zp}\u2215\u2044\uff0f\u29f8]/u;

const SUGGESTION_MAX = 32;
const SUGGESTION_WORDS = 4;

/** Whether `name` is short enough for a project folder: not prose. */
export function isShortProjectName(name) {
  if (typeof name !== "string") return false;
  const words = name.split(/[\s_-]+/u).filter(Boolean);
  return [...name].length <= PROJECT_NAME_MAX && words.length <= PROJECT_NAME_WORDS;
}

// Filler words of German and English requests that say nothing about the project.
const filler = new Set(
  (
    "a an the and or of for to with in on at by from as is are be can could should would " +
    "will want need please me my i you we us it its this that which like same just " +
    "build make create rebuild recreate clone copy write new some every each all " +
    "der die das den dem des ein eine einen einem einer eines und oder wie was wer mit " +
    "für fuer von zu zum zur im in am an auf aus bei ist sind kann können koennen soll " +
    "sollte möchte moechte will bitte mir mich ich du wir uns es er sie mein meine dein " +
    "deine gleiche gleichen gleiches selbe jedes jede jeden jeder alle baue bau mach " +
    "mache erstelle erstell schreib schreibe nachbauen nachbau neue neuen neues so " +
    "target ziel original"
  ).split(" "),
);

// Letters and digits joined by hyphens, lower case, at most `max` characters and
// SUGGESTION_WORDS words.
function slug(words, max) {
  let out = "";
  for (const word of words) {
    const next = out ? `${out}-${word}` : word;
    if ([...next].length > max || next.split("-").length > SUGGESTION_WORDS) break;
    out = next;
  }
  return out;
}

function targetName(target) {
  const text = typeof target === "string" ? target.trim() : "";
  if (!text || text === "-") return null;
  if (/^https?:\/\//i.test(text)) {
    try {
      const host = new URL(text).hostname.replace(/^www\./i, "").replace(/^\[|\]$/g, "");
      return (
        slug(host.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [], SUGGESTION_MAX) || null
      );
    } catch {
      return null;
    }
  }
  if (text.startsWith("/")) {
    const last = text.replace(/\/+$/, "").split("/").pop() ?? "";
    const stem = last.replace(/\.[^.]+$/, "") || last;
    const words = stem.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return slug(words.slice(0, SUGGESTION_WORDS), SUGGESTION_MAX) || null;
  }
  return null;
}

/**
 * A short folder name for a project made from a request (and its target): the target's
 * host or file name, else a few telling words of the request, like `todo-app-dark`.
 * Null when nothing sensible is left: the creator must then name the project.
 */
export function suggestProjectName(request, target) {
  const fromTarget = targetName(target);
  if (fromTarget) return fromTarget;
  const words = (
    String(request ?? "")
      .toLowerCase()
      // A hyphenated word ("to-do") stays one word.
      .match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? []
  ).filter((word) => !filler.has(word));
  return slug(words, SUGGESTION_MAX) || null;
}
