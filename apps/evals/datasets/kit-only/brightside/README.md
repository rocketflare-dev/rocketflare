# Brightside — knowledge-base benchmark corpus (kit-only)

A synthetic corpus for measuring knowledge retrieval, fact extraction and conflict detection
(D43, `docs/plans/knowledge-facts-iteration-1.md`, Phase 0). The documents are ingested through
the real pipeline; the answer keys beside them say what a correct system retrieves, extracts and
flags.

**Kit-only.** `apps/evals/datasets/kit-only/**` is listed in `kitOnly` in `.rocketflare.json`:
the rename deletes it when a copy is made. Never copy this corpus into an app's demo seed. Everything
in it is fictional: people, companies, addresses, `.example` email domains and phone numbers from
the 01632 960xxx drama range.

## The business

**Brightside Grounds & Gardens Ltd** is a 12-person commercial grounds-maintenance company at
Unit 4, Ferris Lane Industrial Estate, Ashcombe. It mows, plants, trims hedges, clears leaves,
does tree work and grits car parks in winter, for businesses only. Customers sit on one of three
plans (Essential, Standard, Premium) with a fixed monthly fee and a fixed visit day. Staff who
appear in the documents: Dana Whitlock (MD), Priya Nandakumar (Operations Manager), Marcus Bell
(Account Manager, then **Operations Lead** from late May 2026), Sophie Tran (Account Executive,
then Account Manager from 25 May 2026), Lena Kowalczyk (office and accounts) and Gareth Pryce
(tree work lead). Brightside itself is not an entity: its own phone numbers and staff emails are
never facts.

## Documents

42 documents in `docs/`, each with front matter `title`, `date` (when it was written; relative
dates in the body resolve against it), `origin` (`upload` or `integration`), `source` (`uploads`,
`inbox`, `crm`) and `kind`. 28 uploads, 14 integrations. Length classes count body characters:
short < 1,500, medium 1,500–6,000, long ≥ 6,000.

| Doc id | Title | Origin | Kind | Date | Length |
|---|---|---|---|---|---|
| `bs-staff-handbook` | Brightside Grounds & Gardens — staff handbook (v3) | upload | handbook | 2025-06-16 | long (7,019) |
| `bs-master-services-agreement` | Master services agreement — standard terms (2025 edition) | upload | contract | 2025-06-30 | long (6,957) |
| `old-mill-contract-2025` | The Old Mill Hotel — site schedule | upload | contract | 2025-07-01 | medium (1,876) |
| `plant-hire-terms` | Ashcombe Plant Hire — hire account | upload | supplier-terms | 2025-07-14 | medium (1,503) |
| `greenleaf-supplier-terms` | Greenleaf Horticultural Supplies — trade account terms | upload | supplier-terms | 2025-08-05 | medium (1,897) |
| `stwilfrids-contract` | St Wilfrid's Primary School — grounds maintenance agreement | upload | contract | 2025-08-11 | medium (2,381) |
| `greenway-supplier-terms` | Greenway Garden Wholesale — account opening letter | upload | supplier-terms | 2025-08-12 | medium (1,579) |
| `bs-winter-prices-2025` | Winter price list 2025/26 | upload | price-list | 2025-09-01 | short (708) |
| `nsg-supplier-terms-2025` | Northern Salt & Grit Co — supply terms 2025/26 | upload | supplier-terms | 2025-09-08 | medium (1,708) |
| `abp-contract` | Ashcombe Business Park — site schedule | upload | contract | 2025-09-22 | medium (2,370) |
| `abp-crm-export-2025` | CRM record — Ashcombe Business Park | integration | call-note | 2025-10-01 | short (672) |
| `thornley-contract` | Thornley Leisure Centre — site schedule | upload | contract | 2025-10-01 | medium (1,742) |
| `fenwick-crm-export` | CRM record — Fenwick & Daughters | integration | call-note | 2025-10-06 | short (505) |
| `riverside-crm-export` | CRM record — Riverside Lodge Care Home | integration | call-note | 2025-10-15 | short (536) |
| `bs-winter-gritting-policy` | Winter gritting policy and procedure 2025/26 | upload | policy | 2025-10-20 | long (6,144) |
| `harbourside-lab-contract` | Harbourside Dental Lab — site schedule | upload | contract | 2025-11-04 | medium (1,747) |
| `kingsgate-email-terms-2025` | Re: KRP supplier set-up | integration | email | 2025-11-18 | medium (1,687) |
| `kingsgate-contract-summary` | Kingsgate Retail Park — contract summary | upload | contract | 2025-11-25 | medium (2,347) |
| `northgate-crm-export` | CRM record — Northgate Veterinary Surgery | integration | call-note | 2025-12-03 | short (382) |
| `bs-service-catalogue-2026` | Brightside service catalogue 2026 | upload | price-list | 2026-01-12 | long (6,861) |
| `stwilfrids-gritting-email` | January invoice — gritting charge? | integration | invoice-query | 2026-01-14 | short (1,452) |
| `fenwick-contract` | Fenwick & Daughters Solicitors — site schedule | upload | contract | 2026-01-20 | medium (1,564) |
| `hvd-contract-2026` | Harbour View Dental — maintenance contract | upload | contract | 2026-02-03 | medium (1,642) |
| `hvd-onboarding-pack` | HVD onboarding pack — crew notes and welcome letter | upload | onboarding | 2026-02-10 | long (6,418) |
| `harbourside-lab-call-note` | Call note — Harbourside Dental Lab, misdirected invoice | upload | call-note | 2026-03-02 | short (536) |
| `kingsgate-email-terms-2026` | Change to contractor payment terms — Kingsgate Estates | integration | email | 2026-03-04 | medium (1,641) |
| `old-mill-fee-letter-2026` | The Old Mill Hotel — letter confirming new monthly fee | upload | contract | 2026-03-12 | short (1,490) |
| `riverside-call-note` | Call note — Riverside Lodge, visit day change | upload | call-note | 2026-04-09 | short (513) |
| `thornley-quote-premium` | Proposal — Thornley Leisure Centre upgrade to Premium | upload | quote | 2026-05-07 | medium (1,793) |
| `hvd-handover-memo` | Account handover — Marcus to Sophie | upload | meeting-notes | 2026-05-18 | medium (2,270) |
| `hvd-fee-email-2026-06` | Re: HVD direct debit amount | integration | email | 2026-06-10 | short (730) |
| `northgate-email-2026` | New phone number — Northgate Vets | integration | email | 2026-06-15 | medium (1,522) |
| `old-mill-meeting-notes` | Old Mill Hotel — summer review meeting | upload | meeting-notes | 2026-06-24 | medium (1,653) |
| `riverside-invoice-query` | Re: Quarterly invoice Q2 — Riverside Lodge | integration | invoice-query | 2026-07-02 | short (689) |
| `abp-email-thread-winter-2026` | Re: Winter 2026/27 at the park — gritting, salt bins and a new contact | integration | email | 2026-07-08 | long (6,410) |
| `thornley-call-note-2026` | Call note — Thornley Leisure Centre, Premium proposal and renewal | upload | call-note | 2026-08-19 | short (1,164) |
| `greenleaf-delivery-email` | Re: Late bark mulch — account GL-40217 | integration | email | 2026-08-20 | medium (1,502) |
| `nsg-supplier-terms-2026` | Northern Salt & Grit Co — supply terms 2026/27 | upload | supplier-terms | 2026-09-03 | medium (1,622) |
| `bs-winter-prices-2026` | Winter price list 2026/27 | upload | price-list | 2026-09-15 | short (968) |
| `bs-ops-meeting-2026-09` | Weekly ops meeting — 28 September 2026 | upload | meeting-notes | 2026-09-28 | medium (1,909) |
| `bs-calendar-export-oct-2026` | Shared calendar export — October 2026 | integration | meeting-notes | 2026-10-02 | short (1,081) |
| `leaf-clearance-price-email` | Leaf season — pricing for extras | integration | email | 2026-10-05 | short (521) |

## Entities

`entities.jsonl` holds every entity a fact refers to; `entity` in `facts.jsonl` equals `name`
there exactly.

| Type | Name | Aliases in the documents |
|---|---|---|
| customer | Harbour View Dental | HVD, the dental practice on Quay St, Harbour View |
| customer | Harbourside Dental Lab | Harbourside — the confusable twin of HVD |
| customer | Ashcombe Business Park | ABP, the park, Kestrel Way |
| customer | St Wilfrid's Primary School | St Wilfrid's, St Wilfrid's C of E Primary School |
| customer | The Old Mill Hotel | the Old Mill |
| customer | Fenwick & Daughters Solicitors | Fenwick & Daughters (LLP) |
| customer | Riverside Lodge Care Home | Riverside Lodge |
| customer | Kingsgate Retail Park | KRP, Kingsgate, the retail park |
| customer | Thornley Leisure Centre | Thornley LC |
| customer | Northgate Veterinary Surgery | Northgate Vets |
| supplier | Greenleaf Horticultural Supplies | Greenleaf — confusable with Greenway |
| supplier | Greenway Garden Wholesale | Greenway |
| supplier | Northern Salt & Grit Co | NSG, Northern |
| supplier | Ashcombe Plant Hire | — |
| service | Lawn mowing, Hedge trimming, Leaf clearance, Weed control, Seasonal planting, Winter gritting (annual plan), Gritting call-out, Rock salt supply, Tree survey | see `entities.jsonl` |

Planted traps: two dental customers with near-identical names; Greenleaf vs Greenway (both sell
plants and compost, only Greenway sells salt); Marcus Bell changes role mid-corpus; contacts that
leave (Helen Okoro at ABP, Ailsa Ferguson at NSG); the winter price tables where only the column
header ("Annual plan, per site" vs "Single call-out") says which £ figure is which.

## Answer keys

- **`facts.jsonl`** — `{ id, entityType, entity, key, value, doc, quote, validFrom, validTo }`.
  Exhaustive: every statement in every document that gives a value for one of the fixed keys of a
  known entity has a line, one per document it appears in (the same fact in two documents is two
  lines — corroboration). `value` is normalised (numbers, ISO dates, booleans, plan-name arrays);
  `quote` is a verbatim substring of the body; relative dates are resolved in `value` /
  `validFrom` against the document date while the quote keeps the wording. Keys:
  - customer: `primary_contact`, `contact_email`, `contact_phone`, `site_address`,
    `service_plan`, `monthly_fee_gbp`, `payment_terms_days`, `contract_renewal_date`,
    `account_manager`, `visit_day`, `gritting_included`
  - supplier: `primary_contact`, `contact_email`, `account_number`, `lead_time_days`,
    `payment_terms_days`, `minimum_order_gbp`
  - service: `price_gbp`, `unit`, `included_in_plans`
- **`conflicts.jsonl`** — `{ id, entityType, entity, key, a, b, winner, why }` (plus an
  informational `pattern`). Every pair of facts with the same entity and key but different values
  is either here or in the non-conflicts list below. `winner` follows the rule: the newer document
  wins only if its origin is at least as trusted as the older one's (upload > integration);
  otherwise the older one wins. Patterns planted: newer upload beats older upload (price rises,
  contacts who left, a moved renewal), newer integration loses to older upload, newer upload beats
  older integration, newer integration beats older integration.
- **`retrieval.jsonl`** — `{ id, query, expected: [{ doc, passage }], tags }`. Passages are
  verbatim sentences or table rows, never spanning a heading. Tags: `keyword`, `paraphrase`,
  `alias`, `heading-context`, `numeric`, `multi-doc`, `long-doc`, `distractor`, `recent`.
- **`chat.jsonl`** — eval cases over the whole corpus (`context: []`; the harness ingests the
  docs): lookups, aliases, multi-doc, relative dates, conflicts (the answer must give both values
  and their sources), two unanswerable questions, one greeting (no tool) and one multi-turn case.

## nonConflicts

Pairs that look like conflicts but are not, so a flag on them is a false alarm:

- `abp-contact-helen-thread` / `abp-contact-raj-thread` — the same email thread says Helen Okoro
  is the contact until 10 July 2026 and Raj Mehta from 13 July: sequential validity in one
  document, not a disagreement. (The CRM's Helen vs the thread's Raj IS listed as a conflict.)
- `hvd-fee-contract` / `hdl-fee-contract` — £285 vs £120 belong to two different customers
  (Harbour View Dental vs Harbourside Dental Lab).
- `hvd-visit-contract` / `hdl-visit-contract` — Tuesday vs Thursday, again two different customers.
- `krp-terms-2026` / `krp-terms-ops` — "net 60" and "60 days": the same value in two formats.
- `nsg-lead-2025` / `nsg-lead-2026` — "2 working days" both years, worded differently.
- `wp26-grit-annual-price` / `wp26-callout-price` — £1,195 and £85 sit in the same table row but
  are different services (annual plan vs single call-out).
- `tlc-fee-contract` / `tlc-fee-quote-current` — both £520. The Thornley quote's **proposed**
  Premium plan at £780 (`thornley-quote-premium`, marked "PROPOSAL (not a contract)") was declined
  and is deliberately **not** a fact; extracting it is a precision error.
- `rlc-fee-invoice` — the invoice query's £1,230 is a quarter (three months at £410): the fact is
  £410 a month; £1,230 is not a monthly fee.

Other statements deliberately left out of `facts.jsonl`: the ABP snow-clearance cap (£1,500, not
a key); Kingsgate "will join Route 2 from 1 December if the contract is signed" in the gritting
policy (conditional); the ABP contract names only "the Facilities Manager for the time being"
(no person); handbook amounts (standby pay, expense limits) belong to Brightside, not an entity.

## Checking it

`apps/evals/kit/corpus.ts` (`checkCorpus`) checks the keys against the documents in the gate:
every quote and passage verbatim, every conflict side present with the same entity and key and a
different value, every fact's entity in `entities.jsonl`.
