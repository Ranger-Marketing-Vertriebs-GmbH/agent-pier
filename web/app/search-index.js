// The ⌘K search's matching and ranking (handoff §5.9). Entries come from
// search-entries.js; every entry carries its labels in German and English and its old
// names, so both languages and the old names match whatever the UI language is.

// Result groups. A blank query shows the recent results, then the areas and actions in
// this order; a query orders the groups by their best match, ties in this order.
export const searchGroups = [
  "recent",
  "sessions",
  "projects",
  "chats",
  "agents",
  "runs",
  "inbox",
  "pages",
  "actions",
];
// How many results a group shows; the rest is reached by a more precise query.
export const groupLimits = {
  recent: 6,
  sessions: 6,
  projects: 5,
  chats: 5,
  agents: 8,
  runs: 6,
  inbox: 5,
  pages: 8,
  actions: 6,
};

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

// Word starts of a normalized text: 0 and every position after a space.
function wordStarts(text) {
  const starts = [0];
  for (let at = text.indexOf(" "); at >= 0; at = text.indexOf(" ", at + 1))
    starts.push(at + 1);
  return starts;
}

/**
 * The fuzzy match of one token in a normalized text: its letters in order, starting
 * at a word start, with at most as many skipped characters as the token is long
 * ("sesion" finds "session", "nsess" finds "new session"). Returns the fewest skipped
 * characters, or null. Tokens shorter than three letters never match fuzzily.
 */
export function fuzzyGaps(text, token) {
  if (token.length < 3) return null;
  let best = null;
  for (const start of wordStarts(text)) {
    if (text[start] !== token[0]) continue;
    let at = start;
    for (let index = 1; index < token.length && at >= 0; index += 1)
      at = text.indexOf(token[index], at + 1);
    if (at < 0) break;
    const gaps = at - start + 1 - token.length;
    if (gaps <= token.length && (best === null || gaps < best)) best = gaps;
    if (best === 0) break;
  }
  return best;
}

// How well tokens match one term, lower is better, null when they do not: 0 exact,
// 1 the term starts with the query, 2 every token starts a word, 4 every token occurs,
// 6 and more when a token only matches fuzzily (fewer skipped characters rank higher).
function matchTerm(term, tokens, joined) {
  if (term.text === joined) return 0;
  if (term.text.startsWith(joined)) return 1;
  let rank = 2;
  let gaps = 0;
  for (const token of tokens) {
    if (term.words.some((word) => word.startsWith(token))) continue;
    if (term.text.includes(token)) {
      rank = Math.max(rank, 4);
      continue;
    }
    const fuzzy = fuzzyGaps(term.text, token);
    if (fuzzy === null) return null;
    rank = 6;
    gaps += fuzzy;
  }
  return rank === 6 ? rank + Math.min(gaps, 9) / 10 : rank;
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

const byScore = (recent) => (a, b) =>
  a.score - b.score ||
  recent(a.entry) - recent(b.entry) ||
  Number(!a.entry.suggested) - Number(!b.entry.suggested) ||
  Number(!a.entry.primary) - Number(!b.entry.primary) ||
  a.order - b.order;

/**
 * The results for a query, grouped: `[{ group, items }]`, best match first within a
 * group; on ties recent results (`options.recent`, ids newest first) come first, then
 * areas (`entry.suggested`), then the main actions (`entry.primary`), then the index
 * order. Groups follow their best match,
 * ties in `searchGroups` order. A blank query shows the recent results that still
 * exist, then the areas and actions.
 */
export function searchEntries(entries, query, limits = groupLimits, options = {}) {
  const tokens = queryTokens(query);
  const recentIds = (options.recent || []).filter((id) => typeof id === "string");
  const recentAt = new Map(recentIds.map((id, at) => [id, at]));
  const recent = (entry) => recentAt.get(entry.id) ?? recentIds.length;
  const found = new Map(searchGroups.map((group) => [group, []]));
  entries.forEach((entry, order) => {
    if (!tokens.length) {
      if (recentAt.has(entry.id))
        found.get("recent").push({ entry, score: 0, order: recent(entry) });
      else if (entry.suggested) found.get(entry.group)?.push({ entry, score: 0, order });
      return;
    }
    const match = rankEntry(entry, tokens);
    if (match)
      found
        .get(entry.group)
        ?.push({ entry, score: match.score, order, alias: match.term.alias || null });
  });
  const sections = searchGroups
    .map((group, rank) => {
      const items = found
        .get(group)
        .sort(byScore(recent))
        .slice(0, limits[group] ?? Infinity);
      return {
        group,
        rank,
        best: items[0]?.score ?? Infinity,
        items: items.map(({ entry, alias }) => ({ ...entry, alias: alias ?? null })),
      };
    })
    .filter((section) => section.items.length);
  if (tokens.length) sections.sort((a, b) => a.best - b.best || a.rank - b.rank);
  return sections.map(({ group, items }) => ({ group, items }));
}
