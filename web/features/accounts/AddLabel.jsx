import React from "react";

// The "+" of a group label; screen readers hear what it adds.
export default function AddLabel({ text }) {
  return (
    <>
      <span aria-hidden="true">+</span>
      <span className="visually-hidden">{text}</span>
    </>
  );
}
