// What proves that the owner explicitly asked a lead to ask or task one specific
// member in this very turn. A lead is semi-trusted (it reads web pages, member
// answers and forwarded text), so only the owner's own words for the named member
// skip the approval; everything else goes to the owner.
export const plain = (value) =>
  value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const words = (value) =>
  plain(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** A verbatim excerpt of at least three words of the owner's own text. */
export const ownerQuote = (quote, text) =>
  typeof quote === "string" &&
  typeof text === "string" &&
  !!quote.trim() &&
  quote.length <= 300 &&
  plain(quote).split(" ").length >= 3 &&
  plain(text).includes(plain(quote));

// Kept deliberately small: one word that means ask or delegate, or a German/English
// verb pair ("gib … an", "lass … machen", "let … do", "hand … over").
const single = [
  /^ask(s|ed|ing)?$/,
  /^delegat(e|es|ed|ing)$/,
  /^assign(s|ed)?$/,
  /^frag(e|en|t|st)?$/,
  /^delegier(e|en|t|st)?$/,
  /^beauftrag(e|en|t|st)?$/,
  /^übergib$/,
  /^übergeben$/,
];
const pairs = [
  [/^gib$/, /^an$/],
  [/^lass(e|t)?$/, /^mach(e|en|t)?$/],
  [/^let$/, /^do$/],
  [/^hand$/, /^(over|off)$/],
];
/** Whether the quote says to ask or to delegate something. */
export function intent(quote) {
  const list = words(quote);
  return (
    list.some((w) => single.some((cue) => cue.test(w))) ||
    pairs.some(([a, b]) => {
      const at = list.findIndex((w) => a.test(w));
      return at >= 0 && list.slice(at + 1).some((w) => b.test(w));
    })
  );
}

/**
 * Whether the quote names `name`: the whole display name, or a word of it (three
 * letters or more) that no other member of the same lead carries.
 */
export function namesMember(quote, name, others = []) {
  const said = words(quote),
    own = words(name);
  if (!own.length) return false;
  const text = ` ${said.join(" ")} `;
  if (text.includes(` ${own.join(" ")} `)) return true;
  const taken = new Set(others.flatMap(words));
  return own.some((w) => w.length >= 3 && !taken.has(w) && said.includes(w));
}
