import React from "react";
import Segment from "./Segment.jsx";

// The settings pattern's segmented control: Segment's radios with the handoff look.
export default function Segmented({ className = "", ...props }) {
  return (
    <Segment {...props} className={["segmented", className].filter(Boolean).join(" ")} />
  );
}
