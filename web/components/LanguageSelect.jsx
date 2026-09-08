import React, { useId } from "react";
import useLanguage from "../lib/i18n/useLanguage.js";
import { setLanguage } from "../lib/i18n/index.js";

export default function LanguageSelect() {
  const language = useLanguage();
  const id = useId();
  return (
    <div className="language-select">
      <label htmlFor={id}>{language === "de" ? "Sprache" : "Language"}</label>
      <select
        id={id}
        value={language}
        onChange={(event) => setLanguage(event.target.value)}
      >
        <option value="de" lang="de">
          Deutsch
        </option>
        <option value="en" lang="en">
          English
        </option>
      </select>
    </div>
  );
}
