// What proves that the owner explicitly asked a lead to give one specific member a
// task in this very turn. A lead is semi-trusted (it reads web pages, member answers
// and forwarded text), so only the owner's own, affirmative words for the named
// member count; the proof lets a delegated task write in the member's workspace.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import {
  mentionLimits,
  mentionableSource,
  nodeText,
  skipped,
  treeMentions,
} from "./member-mentions.js";
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

// Negations in German and English ("don't" splits into "don" and "t"), and words
// that limit a request to reading. Kept broad: a false hit only runs read-only.
const negation =
  /^(nicht|nichts|kein|keine|keinen|keinem|keiner|keines|keinesfalls|nie|niemals|niemand|nirgends|weder|ohne|unverändert|not|never|no|nobody|nothing|none|neither|nor|nowhere|without|unchanged|readonly|dont|doesnt|didnt|isnt|arent|wont|cannot|cant)$/;
const contracted =
  /^(don|doesn|didn|isn|aren|wasn|weren|won|can|couldn|wouldn|shouldn|mustn|hasn|haven|hadn)$/;
const limits = [
  [/^read$/, /^only$/],
  [/^just$/, /^(read|look|review|check)$/],
  [/^look$/, /^only$/],
  [/^only$/, /^(read|look|review|check)$/],
  [/^hands$/, /^off$/],
  [/^nur$/, /^(lesen|lesend|ansehen|anschauen|schauen|gucken|prüfen)$/],
  [/^finger$/, /^weg$/],
  [/^in$/, /^ruhe$/],
];
// "leave … alone" with anything in between.
const alone = (list, n) => list[n] === "alone" && list.slice(0, n).includes("leave");
const negated = (list) =>
  list.some(
    (w, n) =>
      negation.test(w) ||
      (w === "t" && contracted.test(list[n - 1])) ||
      limits.some(([a, b]) => a.test(w) && b.test(list[n + 1] || "")) ||
      alone(list, n),
  );

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
 * frag Max") and whether it follows a quotation mark. Null when the quote is not a
 * whole-word excerpt of the text.
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
  const sentence = haystack.slice(start + 1, found.index + found[0].length);
  return {
    index: boundaries.length,
    negated: negated(words(sentence)),
    quoted: quotedBefore(before),
  };
}
// Text the owner pasted or quoted ("Summarize this mail: 'please ask Max …'") is
// not the owner's instruction; any quotation mark before it fails closed.
const quotedBefore = (before) => /["„“”«»‚‘’‹›]|(^|[\s:(])'/.test(before);

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

// [start, end) offsets of a message, at most this many; beyond, all of it is hidden.
const hiddenLimit = 100;
const ranges = (hidden, length) => {
  if (!Array.isArray(hidden)) return [];
  if (hidden.length > hiddenLimit) return [[0, length]];
  return hidden.flatMap((r) =>
    Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] < r[1]
      ? [[Math.max(0, r[0]), Math.min(length, r[1])]]
      : [],
  );
};

/**
 * The owner's message parsed as the chat parses it: `{ text, tree, hidden }`, or
 * null when it is too large or too deeply nested (`mentionableSource`) or does not
 * parse. `hidden` lists [start, end) offsets that are not the owner's own words
 * either, such as a Telegram message's quotes, code and links (channel-ledger.js).
 * Kept apart so the parse runs outside the store's transaction.
 */
export function parseOwnerText(text, hidden = []) {
  if (typeof text !== "string" || !mentionableSource(text)) return null;
  try {
    const tree = fromMarkdown(text, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    });
    return { text, tree, hidden: ranges(hidden, text.length) };
  } catch {
    return null;
  }
}

/** `parseOwnerText` for `ownerMentions` alone: null when the text holds no "@". */
export const parseOwnerMessage = (text, hidden) =>
  typeof text === "string" && text.includes("@") ? parseOwnerText(text, hidden) : null;

// A negation or a limit to reading anywhere in the message, in any paragraph, list,
// heading, table or footnote, also in quoted or pasted text.
export const messageNegated = ({ text, tree }) =>
  negated(words(text)) || negated(words(nodeText(tree)));

// What stands in the owner's prose where the owner's own words are not: no letter,
// no space, and never part of a quote that may prove anything.
const blank = "\u0000";
// Kept where they stand, so sentences and quotation marks count as in the message.
const kept = /^[.!?;:"„“”«»‚‘’‹›']+$/u;

/**
 * The owner's own prose of a parsed message (`parseOwnerText`): its text with every
 * part the chat does not show as the owner's words blanked out, as for mentions
 * (code, block quotes, struck-through text, links, images, footnotes and HTML) and
 * the `hidden` ranges. Null when the tree is nested too deeply.
 */
export function ownerProse(parsed) {
  if (!parsed) return null;
  const out = parsed.text.split(""),
    hide = [...parsed.hidden];
  let ok = true;
  const walk = (node, depth) => {
    if (depth > mentionLimits.depth) ok = false;
    for (const child of ok ? node.children || [] : []) {
      if (!skipped.has(child.type)) walk(child, depth + 1);
      else {
        const start = child.position?.start?.offset,
          end = child.position?.end?.offset;
        if (Number.isInteger(start) && Number.isInteger(end)) hide.push([start, end]);
        else ok = false;
      }
    }
  };
  walk(parsed.tree, 0);
  if (!ok) return null;
  for (const [start, end] of hide)
    for (let i = start; i < end && i < out.length; i++)
      if (!kept.test(out[i].normalize("NFKC"))) out[i] = blank;
  return out.join("");
}

/**
 * Where the lead's quote of the owner stands in the owner's own prose
 * (`ownerProse`), as `ownerSentence` tells it, or null when it is no whole-word
 * excerpt of at least three words of that prose. `negated` is the whole message's
 * as for mentions (`ownerMentions`): a negation anywhere in it means the quote
 * proves nothing.
 */
export function ownerQuoteProof(quote, parsed) {
  const prose = ownerProse(parsed);
  if (!prose || typeof quote !== "string" || quote.includes(blank)) return null;
  if (!ownerQuote(quote, prose)) return null;
  const sentence = ownerSentence(quote, prose);
  return sentence && { ...sentence, negated: sentence.negated || messageNegated(parsed) };
}

/**
 * Whether a lead's quote proves that the owner asked for a team: at least three
 * words, one of them containing "team" (also "Rechercheteam"), as a whole-word
 * excerpt of the owner's own prose, after no quotation mark and in a message
 * without any negation (`ownerQuoteProof`).
 */
export function ownerTeamQuote(quote, parsed) {
  const found = ownerQuoteProof(quote, parsed);
  return !!found && !found.negated && !found.quoted && plain(quote).includes("team");
}

// The owner's short yes to a lead's offer ("Should I ask Scout?"), in German and
// English: one agreeing word, or two adjacent ones ("go ahead", "mach das").
const agree =
  /^(yes|yeah|yep|yup|sure|ok|okay|alright|absolutely|definitely|ja|jo|jep|jap|klar|gerne|gern|einverstanden|passt|genau|unbedingt)$/;
const agreePairs = [
  [/^go$/, /^(ahead|for)$/],
  [/^do$/, /^(it|that|so)$/],
  [/^sounds$/, /^(good|great|fine)$/],
  [/^mach(e|t)?$/, /^(das|es|ruhig|mal|gerne|gern)$/],
  [/^leg$/, /^los$/],
  [/^nur$/, /^zu$/],
  [/^klingt$/, /^(gut|super)$/],
];
const agrees = (list) =>
  list.some(
    (w, n) =>
      agree.test(w) ||
      agreePairs.some(([a, b]) => a.test(w) && b.test(list[n + 1] || "")),
  );
// At most this many words: consent is a short answer, not a new instruction.
export const consentWords = 12;

/**
 * Whether the lead's quote is the owner's short agreement in this message: the
 * whole own prose is at most `consentWords` words, agrees without any negation or
 * limit anywhere in the message, and the quote is a whole-word excerpt of it that
 * holds the agreeing words and follows no quotation mark. Returns the sentence as
 * `ownerSentence` does, or null. The store accepts it only at the team usage levels
 * where a lead offers members to the owner ("suggest" and "autonomous",
 * lead-request-store.js) and only for a message that names no other member.
 */
export function ownerConsent(quote, parsed) {
  const prose = ownerProse(parsed);
  if (!prose || typeof quote !== "string" || quote.includes(blank)) return null;
  if (!quote.trim() || quote.length > 300 || messageNegated(parsed)) return null;
  const said = words(prose);
  if (!said.length || said.length > consentWords || !agrees(words(quote))) return null;
  if (!wordMatch(plain(quote)).test(plain(prose))) return null;
  const sentence = ownerSentence(quote, prose);
  return sentence && !sentence.negated && !sentence.quoted ? sentence : null;
}

/**
 * The @mentions in the owner's own message (`parseOwnerMessage`), found where the
 * chat shows them as chips (`treeMentions`). Each carries the member it means alone
 * (`memberId`, null when ambiguous), its place among the message's mentions
 * (`ordinal`, so one mention proves one task), the owner sentence it is in
 * (`sentence`, counted as `ownerSentence` counts, so both ways of proof share one
 * sentence), whether a quotation mark comes before it and the paragraph around it
 * (`excerpt`, at most 300 characters) to show the owner why a task may write.
 * `negated` is the whole message's: a negation or a limit to reading anywhere in
 * it, in any paragraph, list, heading, table or footnote, means no mention proves
 * anything; the owner can send such an instruction on its own. A mention in a
 * `hidden` range of the message is none.
 */
export function ownerMentions(parsed, members) {
  if (!parsed) return [];
  const { text, tree } = parsed;
  let found;
  try {
    found = treeMentions(tree, members, text);
  } catch {
    return [];
  }
  if (!found.length) return [];
  const message = messageNegated(parsed),
    hidden = parsed.hidden || [];
  let ordinal = 0;
  return found.flatMap(({ block, mentions }) => {
    const excerpt = Array.from(nodeText(block).trim()).slice(0, 300).join("");
    return mentions.flatMap((m) => {
      // A mention in a hidden range (a Telegram quote or code) is none at all.
      if (
        hidden.some(
          ([start, end]) => m.offset < end && m.offset + m.end - m.start > start,
        )
      )
        return [];
      const before = text.slice(0, m.offset);
      return [
        {
          memberId: m.memberId,
          ordinal: ordinal++,
          sentence: (plain(before).match(/[.!?;:]/g) || []).length,
          negated: message,
          quoted: quotedBefore(before),
          excerpt,
        },
      ];
    });
  });
}
