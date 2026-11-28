# POSITIONING — what Rocketflare is for

**The kit for agentic business applications: one multi-tenant app holding every process as a
domain, with agents acting on its records under each user's permissions.** Internal tools and B2B
products are the two usual shapes: an organisation's own operations app, or a product it sells to
other organisations.

This file is the one place this text lives. The README, `docs/CONCEPTS.md` and `docs/ADAPTING.md`
carry a two-line summary and link here.

## One app, many domains

A business that runs one process on the kit will soon want a second: expenses after purchase
orders, leave requests after timesheets. The second process goes into the app it already has, as
another **domain**, not into a new copy. The people, the organisations, the roles, the sign-in, the
knowledge base, the agents and the audit trail are already there, and an agent can work across
both processes in one run because both sets of tools belong to the same requester.

The rule for where code goes, used everywhere in these docs:

- A **domain** holds this app's own concepts and logic: its orders, its leave requests, the
  rules for approving them. It lives in place under `apps/web/src/<id>/`, listed by hand in
  `src/app.ts` (`docs/CONCEPTS.md` §20).
- A **plugin** is a reusable capability that works across domains and across apps: SSO, analytics,
  a CMS, a connector to an outside system. It is a git repository copied in through
  `pnpm plugin add` (§16).
- Both are **units**: an id, a namespace, the same slots, one boundary check over both.

An app-owned plugin written before domains existed stays a plugin. It keeps working, and moving it
is a choice the owner makes by following the recipe in `docs/CONCEPTS.md` §20.

A new copy is a decision someone argues for, with a reason a domain cannot meet: a separate trust
or customer boundary that tenants cannot express, a regulatory or data-residency boundary, a
high-risk component that needs its own blast radius, or a named platform limit (Worker CPU or
bundle size, a binding count, a different `compatibility_date` or runtime).

## It complements the agent platforms

Copilot, Agentforce, Dust and the other agent platforms are where many people will talk to agents.
Rocketflare does not replace them. It is the governed tool server they reach over MCP (§19): the
person signs in with the app's own login, and every tool call runs as that person, in one
organisation, with that person's permissions. The records, the rules that guard them and the log
of what an agent did stay in the app.

The app's own chat and agent runs use the same tools, so a process works the same whether someone
starts it from the app, from an agent platform, or from the CLI.

## When to buy instead

Buy, rather than build on the kit, when:

- the process already lives inside Salesforce, ServiceNow or Microsoft 365, and the agent only
  needs to act there;
- it is customer service priced per outcome, where a vendor sells the whole loop.

Build on the kit when:

- agents act on your own records, which no vendor holds;
- they must act with each user's permissions inside a tenant, not with one service account;
- the app is sold to your own customers, each an organisation of its own;
- you need to hold the logs and the model contract yourself.
