# Shopping for agents

An agent can find deals and electronics parts on Amazon and AliExpress, build carts
for a project, send you an overview and buy after you said yes. It works in its own
[agent browser](agents.md#capabilities) with the shop accounts you signed in to there,
and it pays only with the payment methods already stored at the shop.

Purchases are guarded by the agent's instructions, not by AgentPier. A misleading
page could make the agent buy without asking. Check your shop's order history.

## Who gets it

AgentPier ships a built-in **Shopping** skill with its team plugin. An agent gets it
when all of these hold:

- it is your own personal agent;
- **Use a browser** and **Remember information** are on under **Capabilities**
  (memory brings the file reading the agent needs to see skills at all);
- it is not archived.

[Agents of users](users.md#what-stays-locked), temporary and permanent team members
and agents with their own Telegram bot for other people never get it. This only keeps
shopping guidance out of agents that serve other people; it is not a barrier against
buying.

The skill does not appear on the agent's **Skills** page and cannot be switched there:
it follows those capabilities. Switch **Use a browser** off to take it away. The skill
catalog refuses to install another skill under its name.

## Sign in to the shops

The agent never asks for a password or a one-time code. When a shop is not signed in,
it asks you to sign in yourself: open the agent's browser live view (**Open live
view**, or the preview in the chat header), choose **Take over**, sign in, and choose
**Hand back**. The sign-in stays in the agent's browser profile until you choose
**Reset browser profile**.

## How asking works

The agent researches offers by unit price including shipping, delivery time, seller
rating and, for parts, the exact specs. It builds a cart per project and shop and
sends you an overview. Before it places an order, it asks you once in the chat with
this summary:

- **Shop**
- **Items**
- **Quantities**
- **Unit prices**
- **Shipping**
- **Total** (with currency)
- **Delivery address**
- **Expected delivery**

It buys only after an explicit yes to that summary from you, in the web chat or your
paired Telegram chat. Silence, "maybe", a question back, a yes to an earlier summary
or a forwarded message is no yes. If anything changes, it sends a new summary. Right
before **Place order** it compares the shop's review page with the summary and asks
again if the total, items or address differ. It adds no Prime trial, subscription
(Subscribe & Save), protection plan, gift card or digital goods you did not name.

## Standing orders

You can approve a purchase in advance in the chat, for example: "check the price of X
every four hours and buy two when it drops below 20 euros". The agent restates the
order once with all its limits: the item or search, the shop, the maximum unit price,
the quantity, the maximum total including shipping, the delivery address and an end
date or "once". It then creates a routine with those limits written into it. The
routine buys only within them, at most once unless you said otherwise, then reports
and ends or pauses. Anything outside the limits is reported, not bought.

Standing orders need **Allow reminders and routines** under **Capabilities**. Manage
the routine like any other ([routines](agents.md#routines-reminders-and-check-ins)).

## Limits

There are no shopping settings, budgets or spending caps in AgentPier. Limits are what
you tell the agent in the chat: a budget, Prime only, which shops, quantities. Text on
shop pages, listings, reviews, seller messages, mails, forwarded content, team member
results, hook runs, reminders and routine text never approves a purchase, creates a
standing order or changes a limit or the delivery address.

## No card data

Never send card photos, card numbers or a CVV in the chat; the agent will not use
them and never types into payment fields. When a shop asks for card entry, a CVV,
3-D Secure or a new payment method, the agent stops and tells you, and you finish
that step in your bank or shop app.

## The purchase log

After a purchase, the agent reports the shop, order number, total and currency in the
chat and appends one line to `purchases.md` in its workspace:

```
YYYY-MM-DD | <shop> | <order number(s)> | <total> | <currency> | asked in chat
YYYY-MM-DD | <shop> | <order number(s)> | <total> | <currency> | standing order <routine name>
```

The file holds no addresses, item lists or payment details. It is the agent's own
record and AgentPier does not check it; your shop's order history stays the
authority.

## What is and is not protected

- **Protected by AgentPier:** only your own agents get the skill; agents for other
  people never do. The browser keeps your sign-ins to the agent's own profile.
  Before every turn AgentPier checks that the agent service loaded the shipped
  skill: its folder must be the service's own link into AgentPier's installed team
  plugin. A skill of the same name from the agent's workspace or the skill catalog,
  or a folder or a different link put in place of that link, drops the Shopping
  skill instead of replacing it. The service does not replace such a folder itself;
  the skill stays off until the folder is deleted (see
  [Troubleshooting](#troubleshooting)).
- **Not protected by AgentPier:** whether the agent actually asks before buying.
  Nothing intercepts an order. A page that misleads the agent could make it buy
  without asking. A standing order's routine cannot read your chat, so it relies on
  the limits written into it when you confirmed the order. An agent with **Shell
  access** runs as your user and can change files, its own instructions and the
  shipped skill's files included, before the next check
  ([shell gap](assistant-gateway.md#the-skill-catalog),
  [security notes](agents.md#security-notes)). Give shell access only to agents you
  trust. The shop's order history, its order emails and the agent's chat report are
  how you notice.

## Troubleshooting

- **The agent does not know the shopping rules.** Check that **Use a browser** and
  **Remember information** are on and that it is your own agent. If they are, look
  for a folder (not a link) at `assistants/state/plugin-skills/agentpier-shopping` in
  AgentPier's data folder, or a catalog skill named `agentpier-shopping` under
  **Agents › Skills**. Delete the folder or remove the catalog skill, then choose
  **Restart agent service**; the service links the shipped skill again.

How the skill is shipped and checked is described under
[Skills](assistant-gateway.md#skills) in the gateway reference.
