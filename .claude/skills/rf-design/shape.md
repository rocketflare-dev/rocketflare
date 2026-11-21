# The shape questions

These are the topics `rf-design` §2 walks, in this order. Each one is a decision the kit makes
cheap now and expensive after the first screens. For each one:
- ask the question in their words;
- give your recommendation, with its reason;
- record the options weighed and what each would cost on this kit.

"Don't know yet" goes to fog, with who answers it and by which stage.

## 1. Organisations: who is kept apart from whom

**Ask:** "Who are the businesses or groups using this, and must any of them be unable to see each
other's information?"

The kit's unit of separation is the **organisation**. Every row belongs to one, every query is
filtered by it, and a test fails any table that isn't (`docs/CONCEPTS.md`, tenancy). Crossing that
line is deliberately hard. So the number of organisations, and what must cross between them, is the
most expensive decision in the design. Weigh it explicitly, and draw it as `diagrams/shape.svg`.

| Shape id | Shape | Fits | Costs on this kit |
|---|---|---|---|
| `single` | One organisation, `TENANCY_MODE=single` | An internal tool for one business | Least of all. Everyone auto-joins the one organisation. `docs/ADAPTING.md` §5 is the recipe |
| `saas` | One organisation per customer, `TENANCY_MODE=multi` | A product sold to unrelated customers, who never share data | What the kit is built for: sign-up, invitations, roles and per-organisation feature flags |
| `one-org-teams` | Several co-operating businesses as ONE organisation, separated by groups and permission rules | Businesses one owner controls, sharing most facts | No sharing layer: shared totals are reports over one set of rows. But separation rests on permission rules a senior role can outrank, so it's weak for privacy-sensitive data |
| `one-org-partners-outside` | One organisation that owns the app. Partners keep their own systems and reach a narrow API with their own key | One business at the centre, with partners who need only a slice | Little work. The partners' screens are not in this app |
| `org-per-business-exchange` | One organisation per business, joined by an exchange that copies only the agreed facts | Partners who must stay separate (replaceable operators, regulated or children's data) | The most work. The kit has no sharing pattern yet (a known gap), so the exchange, consent between organisations, API keys scoped to one contract, per-key limits and the seed order are all the app's. Budget most of a stage for it |

Reading other organisations' rows directly is not an option. It breaks the isolation the kit exists
to keep, and it is the shortcut an agent reaches for first, so name it as ruled out.

**Recommend** the cheapest shape that meets their real separation needs. When they pick
`org-per-business-exchange`, write down the requirement that forces it (who must not see what, and
why). That requirement is the thing to re-check if the cost grows. Record the decision in
`design.json` `tenancy`.

Also settle **who may join**: `SIGNUP_MODE` is `open`, `invite_only` or `approval`, and
`BOOTSTRAP_ADMIN_EMAILS` names the first admin.
- **An internal tool or a closed group of businesses:** recommend `invite_only`.
- **A product people sign up to themselves:** recommend `open`.
- **Self sign-up that someone vets:** `approval`.

Ask about **single sign-on** only if their staff already sign in to work with Google, Microsoft or
another identity provider (`SETUP.md` 2.3b). Otherwise magic links are the default, and they need
nothing set up. Record both in `design.json` `signup`.

## 2. People, roles and words

**Ask:** "Who uses it day to day, and what can each of them do that the others can't?"

The kit's roles are owner, admin and member in each organisation, plus `support`, a role the
platform grants its own staff that the customer can see, so it needs a screen word too. A global
admin is a platform-wide flag, not a role in an organisation. Groups sit inside an organisation. Map each kind of person onto a kit role, plus a group
or a permission rule where the three roles aren't enough. Record:
- the role name they will see on screen;
- the kit role underneath.

Then the **glossary**. Collect the trade words they use for things, actions and places: a folio,
not a bill; a reservation, not a booking; "Business", not "Organisation". For each word, record:
- the screen word;
- its meaning;
- the kit word it replaces;
- the code name, which stays unchanged.

Words decided now go into one terms module per domain from Stage 1. Words decided after the
screens exist mean a pass over every screen, the kit's included, because they are scattered
string literals by then. The kit has no catalogue for its own
fixed words yet (Organisation, Members, API keys). List those in the glossary too, as "kit screens
to reword", so the stage that touches them knows.

**People outside every organisation.** Ask whether anyone uses the app without working for one of
the organisations: guests, patients, parents, a partner's system. The kit has no identity for
them (a known gap). Recommend the narrowest access that works:
- **nothing**, if they never touch the app;
- **a private link** scoped to one record (a stay, an order), for a person;
- **an API key** of the organisation they deal with, for a system, with what it may call written
  down.

Making them members of an organisation gives them that organisation's screens. Recommend it only
when that is the intent. Record each in `design.json` `outsiders`.

## 3. AI: on or off

**Ask:** "Should this app have AI features: chat, agents, searching your documents?"

The kit ships chat, agents and knowledge search. Locally they run on Workers AI, which needs a
Cloudflare login and no key. Setup with `--offline` turns that off, and they answer 503 until a
login or a provider key exists, so an offline setup says nothing about whether the app wants AI.
Ask anyway. If the answer is **off**, write `"ai": "off"`, and add a Stage 1 "Done when": "the
demonstration screens (Chat, Agents, Knowledge, Search) are hidden" (from everyone, unless they
want them kept for some roles). The kit doesn't yet have one switch for
this. Hiding them takes a small guard over the nav and routes, and the design should say so.
Deleting the AI layer isn't recommended: every later kit upgrade would then diverge.

If **on**, ask what the AI does for them, and in which stage. A vague "AI everywhere" becomes fog.

## 4. Money and numbering

**Ask:** "Does the app take, split, or report money? Does anything need a sequence number, like
invoices or receipts?"

The kit has no money code. If the answer is yes, record:
- the currency;
- when amounts are rounded (each purchase, each night, each invoice);
- the rounding rule;
- the taxes by name and who sets their rates;
- whether numbers must be gap-free;
- whether anything is ever deleted, rather than reversed.

Amounts are integer minor units (cents) and never floats. Write a worked example with real figures
from them, and it becomes Stage N's first test. Rates and laws you don't have are fog, never
guesses.

## 5. What must also be true (non-functional)

Ask about each of these briefly, and record a requirement or "no special need":
- **Accessibility:** keyboard-only use, screen readers, and anyone with low vision among the users.
- **Usability:** who is least comfortable with screens, and on what device.
- **Performance:** the slowest screen they'd accept, against how much data in a year.
- **Privacy:** what personal data it holds (children's, health, payment), who may see it, and how
  long it is kept.
- **Time:** time zones, daylight saving, and a business day that ends after midnight.
- **Concurrency:** what must never happen twice (double booking, a payment taken twice).

Each one becomes a "Done when" in the stage that introduces it, not a document nobody reads.

## 6. Where it runs

**Ask:** "Is there any reason this can't run on Cloudflare: an IT policy, where the data must live,
an existing host?"

The kit is Cloudflare-first by design. Realtime, queues, workflows, files, rate limits, cron and
the default AI are Cloudflare services. The database is Postgres (Neon when deployed, or any
Postgres through Hyperdrive), and email is Resend over HTTP. Both are portable. If they need another host, record it as a decision with its cost: those services need
replacements. If it's a "what if", record it as fog for the owner. Don't redesign for it.

## 7. Who owns it and how it is licensed

**Ask:** "Who owns this app, by legal name, and may anyone else use its code?"

The kit's code is MIT-licensed, and its notice must stay with the app. The app's own code is
theirs. Recommend **all rights reserved**, unless they mean to publish it. Record
`owner.legalName` and `owner.licence` in `design.json`. `rf-adapt` writes the app's own `LICENSE`
from these answers and keeps the kit's notice in `LICENSES/kit-MIT.txt`.

## 8. What it connects to, and what already exists

**Ask:** "What other systems does it need to talk to: email, calendars, accounting, files, a
partner's system?"

Run `pnpm plugin list --available` once and match each system, and each sizeable capability from
the destination, against it:
- **A match:** "install `<id>` at Stage N", in `design.json` `plugins`.
- **No match:** built in the app, in the stage that first needs it.
- **Build as a plugin only** if they mean to install it in other apps. A plugin is the format for
  sharing, and its packaging costs a builder time they don't need to spend on their own domain.

For a commercial plugin, the catalogue names its licence terms. Their use is a question for the
owner, so record it as fog until answered.

Each system with no plugin gets:
- what crosses (which data, in which direction);
- how often;
- who holds the credentials.

Unknowns here are fog that blocks the stage that needs them.
