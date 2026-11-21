import React from "react";
// `id` lets a field name its error in aria-describedby.
export default function ErrorMessage({
  error,
  as: Element = "div",
  className = "error",
  id,
}) {
  return error ? (
    <Element id={id} className={className} role="alert">
      {error}
    </Element>
  ) : null;
}
