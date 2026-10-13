/* global document, location */
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { setLanguage } from "../../../../web/lib/i18n/index.js";
// The app's own stylesheet, so sizes are checked under the app's cascade order.
import "../../../../web/styles/index.css";
import ListFixture from "./list-fixture.js";
import TabsFixture from "./tabs-fixture.js";
import DraftFixture from "./draft-fixture.js";
import ShellFixture from "./shell-fixture.js";

// Later tasks add their fixtures here.
const fixtures = {
  tabs: TabsFixture,
  list: ListFixture,
  draft: DraftFixture,
  shell: ShellFixture,
};
const query = new URLSearchParams(location.search);
setLanguage(query.get("lang") === "en" ? "en" : "de", { persist: false });
const Fixture = fixtures[query.get("fixture")];
createRoot(document.getElementById("root")).render(
  Fixture ? h(Fixture) : h("p", null, "Unknown fixture"),
);
