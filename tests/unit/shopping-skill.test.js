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
