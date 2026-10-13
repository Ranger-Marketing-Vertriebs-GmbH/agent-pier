// What proves that the owner explicitly asked a lead to give one specific member a
// task in this very turn. A lead is semi-trusted (it reads web pages, member answers
// and forwarded text), so only the owner's own, affirmative words for the named
// member count; the proof lets a delegated task write in the member's workspace.
import { findMentions } from "./member-mentions.js";
export const plain = (value) =>
  value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const words = (value) =>
  plain(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A match that starts and ends at word boundaries ("ask Max" is not in "unmask Max").
const wordMatch = (needle) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escape(needle)}(?![\\p{L}\\p{N}])`, "u");

/** A verbatim excerpt of at least three whole words of the owner's own text. */
export const ownerQuote = (quote, text) =>
  typeof quote === "string" &&
  typeof text === "string" &&
  !!quote.trim() &&
  quote.length <= 300 &&
  plain(quote).split(" ").length >= 3 &&
  wordMatch(plain(quote)).test(plain(text));

// Negations in German and English ("don't" splits into "don" and "t").
const negation =
  /^(nicht|nichts|kein|keine|keinen|keinem|keiner|keines|keinesfalls|nie|niemals|niemand|nirgends|weder|not|never|no|nobody|nothing|none|neither|nor|nowhere|dont|doesnt|didnt|cannot|cant)$/;
const contracted = /^(don|doesn|didn|can|won|shouldn|mustn)$/;
const negated = (list) =>
  list.some((w, n) => negation.test(w) || (w === "t" && contracted.test(list[n - 1])));

// Kept deliberately small, verb forms only: one word that means ask or delegate,
// "frage" followed by its object, or a German/English verb pair.
const single = [
  /^ask(s|ed|ing)?$/,
  /^delegat(e|es|ed|ing)$/,
  /^assign(s|ed)?$/,
  /^frag(t|st)?$/,
  /^delegier(e|en|t|st)?$/,
  /^beauftrag(e|en|t|st)?$/,
  /^übergib$/,
  /^übergeben$/,
];
// "frage den Max", "frage bitte Max": the verb, not the noun "eine Frage".
const frageObject = /^(den|die|das|dem|bitte|mal|doch|bei|nach)$/;
const pairs = [
  [/^gib$/, /^an$/],
  [/^lass(e|t)?$/, /^mach(e|en|t)?$/],
  [/^let$/, /^do$/],
  [/^hand$/, /^(over|off)$/],
];
/** The index of the first ask or delegate cue in `list`, or -1. */
function cue(list) {
  for (let n = 0; n < list.length; n++) {
    const w = list[n];
    if (single.some((c) => c.test(w))) return n;
    if (w === "frage" && frageObject.test(list[n + 1] || "")) return n;
    for (const [a, b] of pairs)
      if (a.test(w) && list.slice(n + 1).some((x) => b.test(x))) return n;
  }
  return -1;
}
/** Whether the quote says, without negation, to ask or to delegate something. */
export function intent(quote) {
  const list = words(quote);
  return cue(list) >= 0 && !negated(list);
}

/**
 * Where the quote sits in the owner's text: the sentence it belongs to (index),
 * whether that sentence is negated up to the end of the quote ("Bitte nicht …,
 * frag Max") or anywhere (`negatedSentence`, "@Max trag das bitte nicht ein") and
 * whether it follows a quotation mark. Null when the quote is not a whole-word
 * excerpt of the text.
 */
export function ownerSentence(quote, text) {
  const haystack = plain(text),
    found = wordMatch(plain(quote)).exec(haystack);
  if (!found) return null;
  const before = haystack.slice(0, found.index);
  const boundaries = before.match(/[.!?;:\n]/g) || [];
  const start = Math.max(
    ...[".", "!", "?", ";", ":", "\n"].map((c) => before.lastIndexOf(c)),
  );
  const end = found.index + found[0].length;
  const sentence = haystack.slice(start + 1, end);
  const rest = haystack.slice(end).split(/[.!?;:\n]/)[0];
  return {
    index: boundaries.length,
    negated: negated(words(sentence)),
    negatedSentence: negated(words(sentence + " " + rest)),
    // Text the owner pasted or quoted ("Summarize this mail: 'please ask Max …'")
    // is not the owner's instruction; any quotation mark before it fails closed.
    quoted: /["„“”«»‚‘’‹›]|(^|[\s:(])'/.test(before),
  };
}

// Everyday words that never identify a member on their own.
const stop = new Set(
  `bitte please ask frag frage fragen team member mitglied mitglieder agent agentin lead
  leiter assistant assistent the der die das den dem des und and oder or mit with to an
  for für von of nach about über mal doch kannst can could you du ich i me mir all alle
  jetzt now today heute it es was what wie how delegate task aufgabe question new neu
  neue neuer one eins two zwei hey hallo hello hi thanks danke ok okay`.split(/\s+/),
);
const sequence = (list, part) =>
  part.length > 0 && list.some((_, n) => part.every((w, k) => list[n + k] === w));

/**
 * Whether the quote names `name`: its whole display name as whole words (unless a
 * longer name of another member is meant, "Max Ops" for "Max"), or a word of it of
 * three letters or more that no other member carries and that is no everyday word.
 * A name made only of everyday words names nobody.
 */
export function namesMember(quote, name, others = []) {
  const said = words(quote),
    own = words(name);
  if (!own.length || own.every((w) => stop.has(w))) return false;
  const longer = others
    .map(words)
    .some((o) => o.length > own.length && sequence(o, own) && sequence(said, o));
  if (longer) return false;
  if (sequence(said, own)) return true;
  const taken = new Set(others.flatMap(words));
  return own.some(
    (w) => w.length >= 3 && !stop.has(w) && !taken.has(w) && said.includes(w),
  );
}

/**
 * How the quote @-mentions member `id` among the lead's members (`{ id, name }`):
 * "mentioned" when a mention means this member alone, "ambiguous" when one could
 * mean it or another member of the same name, otherwise null. The owner decided
 * that a mention alone is a request to that member; no ask or delegate verb is
 * needed, the negation and quotation checks still are.
 */
export function mentionOf(quote, id, members) {
  const found = findMentions(quote, members);
  if (found.some((m) => m.ambiguous && m.memberIds.includes(id))) return "ambiguous";
  return found.some((m) => m.memberId === id) ? "mentioned" : null;
}
