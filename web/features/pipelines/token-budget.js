// The engine's bound for a token budget (server/features/pipelines/run-budget.js); a
// unit test keeps both equal.
export const MAX_TOKEN_BUDGET = 1_000_000_000;
// A whole number from 1 through the bound, as the field's native validation checks it.
export const TOKEN_BUDGET_PATTERN = "[1-9][0-9]{0,8}|1000000000";
// The field's text as a budget, or NaN when it is no whole number.
export const parseTokenBudget = (text) =>
  /^\d+$/.test(text) ? Number(text) : Number.NaN;
