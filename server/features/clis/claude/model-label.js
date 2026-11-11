// How Claude Code names a model on screen, for every reader of its terminal. One
// pattern, without a list of families: a family the CLI names tomorrow reads the
// same as Opus, Sonnet, Haiku and Fable do today.

/** A family word: one capitalised word ("Fable"). */
export const FAMILY = "[A-Z][a-z]+";
/** `<Family> <major>[.<minor>]`, as a pattern source: "Fable 5.2", "Opus 5". */
export const MODEL_NAME = String.raw`${FAMILY} \d+(?:\.\d+)?`;
const before = "(?:^|[^A-Za-z0-9])";

/**
 * The label of the header row and the status line: the model, with what Claude Code
 * puts in brackets behind it ("(1M context)"), in front of the plan
 * ("· Claude Max", "· API Usage Billing"). The row holds nothing but glyphs before
 * the label, which keeps running text ("see Chapter 3 · Claude …") from reading as
 * a model. An effort the row may name is not part of the label.
 */
export const headerLabel = new RegExp(
  String.raw`(?:^|\n)[^A-Za-z0-9\n]*(${MODEL_NAME}(?: \([^()·\n]*\))*)(?: with [a-z]+ effort)?\s*·\s*(?:Claude|API)`,
);

/** A displayed label in full: family, major, minor, "(1M context)", "(default)". */
export const displayedLabel = new RegExp(
  String.raw`^(${FAMILY}) (\d+)(?:\.(\d+))?( \(1M context\))?( \(default\))?$`,
);

/** A label at the start of a text, as the picker's description of an option has it. */
export const leadingLabel = new RegExp(
  String.raw`^(${MODEL_NAME}(?: \(1M context\))?)\s+·\s`,
);

/**
 * Whether a composer footer names a model: a label, a model id (a custom status
 * line) or a family's limit. One of the signs that the row above is the live prompt.
 */
export const footerNamesModel = new RegExp(
  String.raw`${before}(?:${MODEL_NAME}(?![\w.])|${FAMILY} limit\b)|\bclaude-[a-z]+-\d`,
);
