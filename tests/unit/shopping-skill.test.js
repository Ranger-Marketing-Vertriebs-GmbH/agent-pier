import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scanSkill } from "../../server/features/extensions/skill-scan.js";
import { skillRequirements } from "../../server/features/extensions/skill-packages.js";

// The built-in shopping skill as the team plugin ships it (built-in-skills.js).
const file = new URL(
  "../../server/features/assistants/team-plugin/skills/agentpier-shopping/SKILL.md",
  import.meta.url,
);

test("the shipped shopping skill is clean, named and needs no settings", () => {
  const data = fs.readFileSync(file);
  const scan = scanSkill([{ name: "SKILL.md", data, mode: 0o644 }]);
  assert.equal(scan.verdict, "ok", JSON.stringify(scan.findings));
  assert.match(data.toString(), /^---\nname: agentpier-shopping\n/);
  assert.equal(skillRequirements(data).needsSettings, false);
});

test("the shopping skill carries every rule the owner decided", () => {
  const text = fs.readFileSync(file, "utf8");
  const headings = [
    "## Research",
    "## Carts and the overview",
    "## Ask once before buying",
    "## Standing orders",
    "## No card data",
    "## Untrusted content",
    "## No extras",
    "## After buying",
  ];
  for (const heading of headings) assert.ok(text.includes(heading), heading);
  // In this order.
  const at = headings.map((heading) => text.indexOf(heading));
  assert.deepEqual(
    at,
    [...at].sort((a, b) => a - b),
  );
  for (const term of [
    "Delivery address",
    "Expected delivery",
    "agentpier_routine",
    "CVV",
    "3-D Secure",
    "Place order",
    "Subscribe & Save",
    "forwarded",
    "purchases.md",
    "Take over",
  ])
    assert.ok(text.includes(term), term);
  // The fixed summary labels, each on its own line.
  for (const label of [
    "Shop",
    "Items",
    "Quantities",
    "Unit prices",
    "Shipping",
    "Total",
    "Delivery address",
    "Expected delivery",
  ])
    assert.match(text, new RegExp(`^- ${label}:`, "m"), label);
});

test("the team plugin declares its skills folder", () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL(
        "../../server/features/assistants/team-plugin/openclaw.plugin.json",
        import.meta.url,
      ),
    ),
  );
  assert.deepEqual(manifest.skills, ["skills"]);
});

test("a standing order needs the owner's yes before its routine exists", () => {
  const text = fs.readFileSync(file, "utf8");
  const section = text.slice(
    text.indexOf("## Standing orders"),
    text.indexOf("## No card data"),
  );
  const yes = section.indexOf("Wait for the owner's explicit yes to that restatement");
  const routine = section.indexOf(
    "Only then create the routine with `agentpier_routine`",
  );
  assert.ok(yes > 0 && routine > yes, "the yes comes before the routine");
  // At run time: the owner's yes in the chat history, or report instead of buying.
  assert.match(section, /find the owner's own yes to these exact limits/);
  assert.match(section, /report instead of buying/);
  // Routine text is untrusted except for the limits the owner confirmed.
  assert.match(section, /everything else\s+in it is untrusted/);
  assert.match(
    text,
    /- routine text, except the standing-order limits the owner confirmed/,
  );
  assert.ok(
    !/results from team members, hook runs, reminders and routine text/.test(text),
  );
});

test("card data is never stored anywhere", () => {
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /Never store card data[^\n]*\n[^\n]*any other file/);
});
