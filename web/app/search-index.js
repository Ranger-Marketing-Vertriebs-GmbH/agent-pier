// The ⌘K search's matching and ranking (handoff §5.9). Entries come from
// search-entries.js; every entry carries its labels in German and English and its old
// names, so both languages and the old names match whatever the UI language is.

export const searchGroups = ["pages", "agents", "actions"];
// How many results a group shows; the rest is reached by a more precise query.
export const groupLimits = { pages: 8, agents: 8, actions: 6 };

// Lower case without diacritics; "ß" reads "ss". Anything but letters and digits
// separates words, so "SSH/SFTP-Zugänge" holds the words "ssh", "sftp", "zugange".
export function normalizeText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// The German spelling without umlauts ("Zugaenge"), which people type on keyboards
// without them.
function transliterate(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue");
}

/**
 * A searchable term: its normalized text and words. `weight` ranks where the text comes
 * from: 0 the entry's own label, 1 its path or an old name, 2 extra words (host names).
 */
export function searchTerm(text, weight = 0) {
  const normal = normalizeText(text);
  return { text: normal, words: normal ? normal.split(" ") : [], weight };
}

/** Terms of one text, with its spelling without umlauts when that differs. */
export function termsOf(text, weight = 0) {
  const terms = [searchTerm(text, weight)];
  const spelled = normalizeText(transliterate(text));
  if (spelled !== terms[0].text) terms.push(searchTerm(spelled, weight));
  return terms.filter((term) => term.text);
}

/** The query's tokens, normalized; empty for a blank query. */
export function queryTokens(query) {
  const normal = normalizeText(query);
  return normal ? normal.split(" ") : [];
}

// How well tokens match one term, lower is better, null when they do not: 0 exact,
// 1 the term starts with the query, 2 every token starts a word, 4 every token occurs.
function matchTerm(term, tokens, joined) {
  if (term.text === joined) return 0;
  if (term.text.startsWith(joined)) return 1;
  let rank = 2;
  for (const token of tokens) {
    if (term.words.some((word) => word.startsWith(token))) continue;
    if (!term.text.includes(token)) return null;
    rank = 4;
  }
  return rank;
}

/** The best rank of an entry for the tokens, or null when it does not match. */
export function rankEntry(entry, tokens) {
  const joined = tokens.join(" ");
  let best = null;
  for (const term of entry.terms) {
    const rank = matchTerm(term, tokens, joined);
    if (rank === null) continue;
    const score = rank * 3 + term.weight;
    if (best === null || score < best.score) best = { score, term };
    if (score === 0) break;
  }
  return best;
}

/**
 * The results for a query, grouped in `searchGroups` order: `[{ group, items }]`,
 * best match first within a group; on ties areas (`entry.suggested`) come first, then
 * the index order. A blank query shows the areas and actions.
 */
export function searchEntries(entries, query, limits = groupLimits) {
  const tokens = queryTokens(query);
  const found = new Map(searchGroups.map((group) => [group, []]));
  entries.forEach((entry, order) => {
    if (!tokens.length) {
      if (entry.suggested) found.get(entry.group)?.push({ entry, score: 0, order });
      return;
    }
    const match = rankEntry(entry, tokens);
    if (match)
      found
        .get(entry.group)
        ?.push({ entry, score: match.score, order, alias: match.term.alias || null });
  });
  return searchGroups
    .map((group) => ({
      group,
      items: found
        .get(group)
        .sort(
          (a, b) =>
            a.score - b.score ||
            Number(!a.entry.suggested) - Number(!b.entry.suggested) ||
            a.order - b.order,
        )
        .slice(0, limits[group] ?? Infinity)
        .map(({ entry, alias }) => ({ ...entry, alias })),
    }))
    .filter((section) => section.items.length);
}
