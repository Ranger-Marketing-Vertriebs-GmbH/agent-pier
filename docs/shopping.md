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

- **Use a browser** and **Remember information** are on under **Capabilities**
  (memory brings the file reading the agent needs to see skills at all). A permanent
  team member also counts what its lead shares with it; a temporary team member
  needs the browser granted by its lead and always has its own memory;
- the **Shopping** switch under **Capabilities** is on;
- it is not an [agent of users](users.md#what-stays-locked);
- it is not archived.

That includes your own agents, leads, permanent and temporary team members and agents
with their own Telegram bot for other people. Agents of users and archived agents
never get it. Who may say yes to a purchase is a different question: only you, in
your own chat (see [Whose yes counts](#whose-yes-counts)).

The skill does not appear on the agent's **Skills** page and cannot be switched there.
The catalog refuses to install another skill under its name.

## The Shopping switch

**Capabilities › Shopping** turns the skill off or on for one agent. It is on by
default for every agent that may shop, and stored on the agent's profile: the agent
service drops the skill at once when you save it off, and every later apply, a
restart included, keeps it out until you switch it on again. A temporary team member
has no switch of its own: it follows its lead's, so switching shopping off for a lead
switches it off for its temporary members. A temporary member's Capabilities tab
shows its lead's switch, read only.

When the agent cannot shop, the switch is off and disabled and says why: it needs
**Use a browser**, it needs **Remember information**, it is an agent of users, it is
archived, or, for a temporary member, shopping is off for its lead.

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

It buys only after an explicit yes to that summary from you, in your own chat with
the agent (see below). Silence, "maybe", a question back, a yes to an earlier summary
or a forwarded message is no yes. If anything changes, it sends a new summary. Right
before **Place order** it compares the shop's review page with the summary and asks
again if the total, items or address differ. It adds no Prime trial, subscription
(Subscribe & Save), protection plan, gift card or digital goods you did not name.

## Whose yes counts

Only you approve a purchase, and only in your own chat with the agent: its web chat in
AgentPier or your paired Telegram chat, which AgentPier passes into that chat. A yes
from anyone else never counts: another person on the agent's own Telegram bot, a lead
agent, a team member, a member's result, a routine, a reminder, a hook run, a mail, a
web page or forwarded content.

The skill tells the agent how to tell these apart. AgentPier marks every turn it sends
or relays that is not your own message: a lead's or member's task or question ("Task
from", "Question from"), a member's outcome ("Follow-up for the owner", "Answer from",
"Report from"), forwarded Telegram content, check-ins, routine runs, hook runs,
reminders, finished background commands and work-goal continuations. A marked turn is
never yours, and a missing mark alone never makes a turn yours: only a plain message in
your web chat or your paired Telegram chat counts. Messages to the agent's own Telegram
bot run in a separate chat of the agent service, whose message context names the
Telegram channel and the bot; AgentPier's tools refuse to work there. Such a chat is
never yours, even when you write to the bot yourself. People on the bot can ask the
agent to look for something, but it never buys for them, never asks them to confirm and
never tells them about your shop accounts, addresses, orders or payment methods. When
the agent cannot tell that a message is your own, it treats it as no yes and asks you.

AgentPier does not pass the agent a separate "this is the owner" marker: its owner
checks (`directOwnerTurn`) guard AgentPier's own tools, not the agent's text, and
OpenClaw's `senderIsOwner` is not shown to the agent. The skill relies on the framing
and the message context above.

## Team members

A lead cannot pass on your yes, and a task never lets a member buy.

- A **permanent member** builds the cart for a task from its lead or a fellow member,
  ends the task with the summary as its result and says that you still have to
  confirm it. It buys only after your explicit yes in its own chat (its web chat or
  your paired Telegram chat for it).
- A **temporary member** never buys during its task: you cannot write in its chat
  while the task runs, and its browser profile, with any shop sign-in, ends with the
  team. It hands the cart back to its lead.
- The **lead** never buys from a member's result. To buy it itself, it rebuilds the
  cart in its own browser, sends you its own summary in its own chat and buys after
  your yes there; otherwise it tells you to confirm in the member's chat. It never tells a
  member that you said yes.

A routine a lead sets up on a member is never a standing order and never buys.

## Standing orders

You can approve a purchase in advance in the chat, for example: "check the price of X
every four hours and buy two when it drops below 20 euros". The agent restates the
order once with all its limits: the item or search, the shop, the maximum unit price,
the quantity, the maximum total including shipping, the delivery address and an end
date or "once". It waits for your explicit yes to that restatement in the chat and
only then creates a routine with the confirmed limits and the date you confirmed
them written into it. The routine buys only within them, at most once unless you
said otherwise, then reports and ends or pauses. Anything outside the limits is
reported, not bought. A routine run cannot read your chat, so it relies on the
limits in its own text; everything else in that text counts as untrusted.

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

- **Protected by AgentPier:** agents of users never get the skill, and the **Shopping**
  switch takes it away from any agent. The browser keeps your sign-ins to the agent's
  own profile. Before every turn AgentPier checks that the agent service loaded the
  shipped skill: its folder must be the service's own link into AgentPier's installed
  team plugin. A skill of the same name from the agent's workspace or the skill catalog,
  or a folder or a different link put in place of that link, drops the Shopping skill
  instead of replacing it. The service does not replace such a folder itself; the skill
  stays off until the folder is deleted (see [Troubleshooting](#troubleshooting)).
- **Not protected by AgentPier:** whether the agent actually asks before buying. Nothing
  intercepts an order. A page that misleads the agent could make it buy without asking,
  and whether it tells your own chat from another person's message is up to its
  instructions too. A standing order's routine cannot read your chat, so it relies on
  the limits written into it when you confirmed the order. An agent with **Shell
  access** runs as your user and can change files, its own instructions and the shipped
  skill's files included, before the next check ([shell
  gap](assistant-gateway.md#the-skill-catalog), [security
  notes](agents.md#security-notes)). Give shell access only to agents you trust. The
  shop's order history, its order emails and the agent's chat report are how you notice.

## Troubleshooting

- **The agent does not know the shopping rules.** Check **Capabilities › Shopping**:
  the switch is on, or says what is missing. If it is on, look
  for a folder (not a link) at `assistants/state/plugin-skills/agentpier-shopping` in
  AgentPier's data folder, or a catalog skill named `agentpier-shopping` under
  **Agents › Skills**. Delete the folder or remove the catalog skill, then choose
  **Restart agent service**; the service links the shipped skill again.

How the skill is shipped and checked is described under
[Skills](assistant-gateway.md#skills) in the gateway reference.
