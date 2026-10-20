import React from "react";
import { TOKEN_BUDGET_PATTERN } from "./token-budget.js";

// A token budget is a large count, typed rather than stepped: a text field with the
// numeric keyboard and no native spinners, like the other count fields of the app.
export default function TokenBudgetInput({ value, onChange, ...props }) {
  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      pattern={TOKEN_BUDGET_PATTERN}
      value={value}
      onChange={(event) => onChange(event.target.value.trim())}
      {...props}
    />
  );
}
