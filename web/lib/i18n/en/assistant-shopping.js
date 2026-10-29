export const assistantShoppingCopy = {
  title: "Shopping",
  hint: "Nothing in AgentPier stops a purchase: the agent's instructions are the only guard. Check your shop's order history.",
  description:
    "Finds deals and parts on Amazon and AliExpress and buys only after your yes in your own chat.",
  needs: (label) => `Needs “${label}”.`,
  userAgent: "Agents of users never shop.",
  archived: "Archived agents do not shop.",
  lead: "Off while shopping is off for the lead agent.",
  followsLead: "Follows the lead agent's Shopping switch.",
};
