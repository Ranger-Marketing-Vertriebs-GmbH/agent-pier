import { cliDefinition, codingCliIds } from "../../../server/features/clis/catalog.js";
export const providerNames = Object.fromEntries(
  codingCliIds().map((id) => [id, cliDefinition(id).shortName]),
);
