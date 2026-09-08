import React from "react";
export default function ErrorMessage({
  error,
  as: Element = "div",
  className = "error",
}) {
  return error ? (
    <Element className={className} role="alert">
      {error}
    </Element>
  ) : null;
}
