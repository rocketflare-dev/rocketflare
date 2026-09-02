/**
 * Development seed (D9, D25) — idempotent, run as `pnpm seed` (loads .dev.vars). Multi-tenant:
 * tenant `Acme` (`acme`) with owner/admin/member `*@example.test` (verified), a pending invitation
 * for `invited@example.test`, one API key printed ONCE (only its hash is stored) and a global
 * admin `admin@rocketflare.local`. `TENANCY_MODE=single`: the single tenant is named after `APP_NAME`
 * with slug `default` instead. Node-only script; the Worker never imports it.
 *
 * `pnpm seed --demo` (or `SEED_DEMO=1`) additionally fills the workspace with a realistic picture
 * of a logistics company in use — more members, two sibling tenants, two weeks of activity,
 * conversations, an indexed knowledge base, finished agent runs, an AI usage ledger and rebuilt
 * fact tables — so every page has something to show. Every demo row carries a fixed id derived
 * from a namespace (`demoId`) and is inserted `onConflictDoNothing`, so re-running adds nothing
 * (timestamps are therefore frozen at the first demo run) — except what is DERIVED from the demo
 * document texts: a changed text replaces that document's content and chunks, and the two agent
 * runs' input/output and tool-result events are re-derived on every run. Chunk vectors come from
 * `deterministicEmbedding` (no embeddings provider exists under `tsx`): against a query embedded by
 * the real provider the dense half of the hybrid search is noise, so it is the lexical half
 * (`websearch_to_tsquery`) that finds a seeded passage from `/search` or `search_knowledge`.
 */
import { createHash } from 'node:crypto'
import {
  agentStepEventDataSchema,
  researchTopicInputSchema,
  researchTopicOutputSchema,
  SUMMARIZE_TEXT_MAX_CHARS,
  summarizeTextInputSchema,
  summarizeTextOutputSchema,
} from '@rocketflare/shared/ai/agents'
import { type TokenUsage, tokenUsageSchema } from '@rocketflare/shared/ai/chat'
import { type AiProvider, WORKERS_AI_CHAT_MODEL } from '@rocketflare/shared/ai/config'
import { estimateCostMicrocents } from '@rocketflare/shared/ai/pricing'
import { and, count, eq, gt, isNull, sql } from 'drizzle-orm'
import { mintApiKey } from '../src/api/auth/api-keys'
import { chunkText } from '../src/api/services/ai/chunking'
import {
  DETERMINISTIC_EMBEDDING_MODEL,
  deterministicEmbedding,
} from '../src/api/services/ai/deterministic-embedding'
import { ensureDefaultDashboards } from '../src/api/services/dashboard-templates'
import { refreshAllFactTables } from '../src/api/services/fact-tables'
import { hashToken } from '../src/api/utils/core/hash'
import { randomToken } from '../src/api/utils/core/ids'
import { createTenantForUser, getSingleTenant } from '../src/api/utils/db/tenant-helpers'
import { closeAllDatabases, type Database, getScriptDatabase } from '../src/db/client'
import {
  activityEvents,
  agentRunEvents,
  agentRuns,
  aiUsage,
  analyticsPages,
  apiKeys,
  chunks,
  conversations,
  documents,
  messages,
  teamInvitations,
  tenantActivityDailyFacts,
  tenants,
  tenantUsers,
  users,
} from '../src/db/schema'

const DATABASE_URL = process.env.DATABASE_URL
const TENANCY_MODE = process.env.TENANCY_MODE === 'single' ? 'single' : 'multi'
const APP_NAME = process.env.APP_NAME || 'Rocketflare'
const APP_URL = process.env.APP_URL || 'http://localhost:3000'
const DEMO = process.argv.includes('--demo') || process.env.SEED_DEMO === '1'

const SEED_USERS = [
  { email: 'owner@example.test', name: 'Olivia Owner', role: 'owner' },
  { email: 'admin@example.test', name: 'Adam Admin', role: 'admin' },
  { email: 'member@example.test', name: 'Mia Member', role: 'member' },
] as const
const GLOBAL_ADMIN = { email: 'admin@rocketflare.local', name: 'Platform Admin' }
const INVITED_EMAIL = 'invited@example.test'
const SEED_KEY_NAME = 'Seed key'

async function upsertUser(
  db: Database,
  input: { email: string; name: string; isGlobalAdmin?: boolean }
) {
  const existing = await db.query.users.findFirst({
    where: sql`lower(${users.email}) = ${input.email.toLowerCase()}`,
  })
  if (existing) {
    if (input.isGlobalAdmin && !existing.isGlobalAdmin) {
      await db.update(users).set({ isGlobalAdmin: true }).where(eq(users.id, existing.id))
    }
    return existing
  }
  const [created] = await db
    .insert(users)
    .values({
      email: input.email,
      name: input.name,
      isGlobalAdmin: input.isGlobalAdmin ?? false,
      emailVerifiedAt: new Date(),
    })
    .returning()
  if (!created) throw new Error(`seed: could not create ${input.email}`)
  return created
}

async function ensureMembership(
  db: Database,
  tenantId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member'
) {
  await db.insert(tenantUsers).values({ tenantId, userId, role }).onConflictDoNothing()
}

async function main() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required (pnpm seed loads .dev.vars)')
  if (!/localhost|127\.0\.0\.1/.test(DATABASE_URL) && !process.env.SEED_ALLOW_REMOTE) {
    throw new Error('Refusing to seed a non-local database (set SEED_ALLOW_REMOTE=1 to override)')
  }
  const db = getScriptDatabase(DATABASE_URL)
  const log = (s: string) => console.log(s)

  log(`Seeding (${TENANCY_MODE}-tenant mode)…`)
  const owner = await upsertUser(db, SEED_USERS[0])

  let tenant: typeof tenants.$inferSelect
  if (TENANCY_MODE === 'single') {
    const single = await getSingleTenant(db)
    tenant =
      single ??
      (await createTenantForUser(db, {
        name: APP_NAME,
        slug: 'default',
        userId: owner.id,
        role: 'owner',
      }))
  } else {
    const acme = await db.query.tenants.findFirst({ where: eq(tenants.slug, 'acme') })
    tenant =
      acme ??
      (await createTenantForUser(db, {
        name: 'Acme',
        slug: 'acme',
        userId: owner.id,
        role: 'owner',
      }))
  }
  log(`  tenant  ${tenant.name} (${tenant.slug})`)

  for (const seedUser of SEED_USERS) {
    const user = await upsertUser(db, seedUser)
    await ensureMembership(db, tenant.id, user.id, seedUser.role)
    log(`  user    ${seedUser.email.padEnd(24)} ${seedUser.role}`)
  }

  const globalAdmin = await upsertUser(db, { ...GLOBAL_ADMIN, isGlobalAdmin: true })
  if (TENANCY_MODE === 'single') await ensureMembership(db, tenant.id, globalAdmin.id, 'member')
  log(`  user    ${GLOBAL_ADMIN.email.padEnd(24)} global admin`)

  const pendingInvite = await db.query.teamInvitations.findFirst({
    where: and(
      eq(teamInvitations.tenantId, tenant.id),
      sql`lower(${teamInvitations.email}) = ${INVITED_EMAIL}`,
      isNull(teamInvitations.acceptedAt),
      isNull(teamInvitations.revokedAt)
    ),
  })
  if (!pendingInvite) {
    const token = randomToken(32)
    await db.insert(teamInvitations).values({
      tenantId: tenant.id,
      email: INVITED_EMAIL,
      role: 'member',
      tokenHash: await hashToken(token),
      invitedByUserId: owner.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    log(`  invite  ${INVITED_EMAIL.padEnd(24)} pending → ${APP_URL}/invite/${token}`)
  } else {
    log(`  invite  ${INVITED_EMAIL.padEnd(24)} pending (existing)`)
  }

  const existingKey = await db.query.apiKeys.findFirst({
    where: and(
      eq(apiKeys.tenantId, tenant.id),
      eq(apiKeys.name, SEED_KEY_NAME),
      isNull(apiKeys.revokedAt)
    ),
  })
  if (!existingKey) {
    const { plaintext } = await mintApiKey(db, {
      tenantId: tenant.id,
      createdByUserId: owner.id,
      name: SEED_KEY_NAME,
      scopes: ['read', 'write'],
    })
    log('')
    log('  API key (shown ONCE — only its hash is stored):')
    log(`    ${plaintext}`)
  } else {
    log(
      `  API key ${existingKey.keyPrefix}… already exists (revoke it and re-seed to mint a new one)`
    )
  }

  log('')
  log('Sign in locally (APP_ENV=development) without email:')
  log(`  curl -sS -X POST ${APP_URL.replace(':3000', ':3001')}/auth/dev-login \\`)
  log(
    `    -H 'Content-Type: application/json' -d '{"email":"${SEED_USERS[0].email}"}' -c cookies.txt`
  )
  log(
    `  or open ${APP_URL}/login and use the dev-login form with any *@example.test address above.`
  )
  log(`  Magic links are logged by wrangler dev when RESEND_API_KEY is unset.`)

  if (DEMO) await seedDemo(db, tenant, owner, log)
}

// =================================================================================================
// --demo: a workspace in use. Everything below is additive, keyed by `demoId`, and re-runnable.
// =================================================================================================

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const NOW = Date.now()
/** `d` days, `h` hours and `m` minutes before now. */
const ago = (d: number, h = 0, m = 0) => new Date(NOW - d * DAY - h * HOUR - m * MINUTE)

/**
 * A fixed UUID for a demo row: SHA-1 of a namespaced key, with the version nibble set to 5 and the
 * RFC 4122 variant bits set, so `z.string().uuid()` (which every API contract uses) accepts it.
 */
function demoId(key: string): string {
  const hex = createHash('sha1').update(`rocketflare-demo:${key}`).digest('hex').slice(0, 32)
  const variant = ['8', '9', 'a', 'b'][Number.parseInt(hex[16] ?? '0', 16) % 4]
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

const DEMO_TENANT_NAME = 'Acme Logistics'
const DEMO_SEED_USER_NAMES: Record<(typeof SEED_USERS)[number]['email'], string> = {
  'owner@example.test': 'Olivia Bennett',
  'admin@example.test': 'Marcus Adeyemi',
  'member@example.test': 'Priya Raman',
}

const DEMO_MEMBERS = [
  { email: 'sofia.marchetti@acme.example', name: 'Sofia Marchetti', role: 'admin', joined: 12 },
  { email: 'liam.oconnor@acme.example', name: 'Liam O’Connor', role: 'member', joined: 10 },
  { email: 'aisha.khan@acme.example', name: 'Aisha Khan', role: 'member', joined: 8 },
  { email: 'tomasz.nowak@acme.example', name: 'Tomasz Nowak', role: 'member', joined: 5 },
  { email: 'grace.lin@acme.example', name: 'Grace Lin', role: 'member', joined: 2 },
] as const

const DEMO_TENANTS = [
  {
    name: 'Northwind Freight',
    slug: 'northwind',
    owner: { email: 'hannah.kowalski@northwind.example', name: 'Hannah Kowalski' },
  },
  {
    name: 'Bluebird Clinics',
    slug: 'bluebird',
    owner: { email: 'daniel.osei@bluebird.example', name: 'Daniel Osei' },
  },
] as const

const CLAUDE_MODEL = 'claude-sonnet-4-5'

// ---- Knowledge base -----------------------------------------------------------------------------

/**
 * Four indexed documents of 15–18k characters each (6–8 chunks at the real `chunkText` window), so
 * a demo workspace has enough passages for search and the agents to rank against — and one left
 * `pending`. They are Markdown with EXACTLY one blank line between paragraphs and no indented
 * lines, because `chunkText` splits on blank lines and trims, and the research run's citation
 * locates its passage with `indexOf` (the same answer retrieval's `position()` gives). The audit
 * doc is also the `summarize-text` run's input, so it stays under `SUMMARIZE_TEXT_MAX_CHARS`.
 * Changing a text is safe: the seed replaces a document's content and chunks when they differ.
 */
interface DemoDocument {
  key: string
  title: string
  text: string
  /** Left `pending` with no chunks, so the Knowledge page shows one row still indexing. */
  pending?: boolean
  /** Days ago it was pasted. */
  createdDaysAgo: number
}

const DEMO_DOCUMENTS: DemoDocument[] = [
  {
    key: 'carrier-onboarding',
    title: 'Carrier onboarding checklist',
    createdDaysAgo: 11,
    text: `# Carrier onboarding checklist

Version 4.2 — effective 1 June. Owner: Carrier Management. Review: annually, or after any change to the operator licence undertakings, the insurance programme or the TMS carrier module. Supersedes version 4.1 (February).

Every new carrier goes through the same six gates before the first load is tendered. The carrier manager owns the file; nothing moves to the TMS until the last gate is signed off in the onboarding tracker. The gates exist because the three worst incidents in the company's history — the uninsured trailer fire at Immingham, the unlicensed subcontractor on the Milton Keynes lane and the £48,000 pallet-network claim we could not recover — each came from a step that had been skipped to get a truck moving on a Friday afternoon. Nobody is authorised to waive a gate. The head of operations may re-sequence gates 4 and 5 for a carrier with an existing framework agreement, and that decision is recorded in the tracker with a reason.

## Who does what

| Role | Responsibility in onboarding |
| --- | --- |
| Carrier manager | Owns the file, chases documents, signs off gates 1, 3 and 6 |
| Compliance analyst | Verifies licences and insurance against the public registers, signs off gate 2 |
| Pricing analyst | Loads rate cards and surcharge mechanisms, signs off gate 4 |
| TMS administrator | Creates the carrier record, portal users and integrations, signs off gate 5 |
| Head of operations | Approves exceptions, reviews carriers that fail the trial period |
| Accounts payable | Confirms the self-billing agreement and bank verification call |

## Timeline

A standard onboarding takes ten working days from the introductory call to the first tender. The tracker records the date each gate opened and closed, and the weekly carrier review picks up any file older than fifteen working days. The most common cause of delay is insurance documentation (gate 2), followed by the compliance questionnaire (gate 3). A carrier that has not returned the questionnaire within ten working days of receiving it is marked inactive and must restart from gate 1 if it re-applies.

| Day | Milestone |
| --- | --- |
| 0 | Introductory call, information pack sent, tracker file opened |
| 1–3 | Legal entity documents and licence returned (gate 1) |
| 2–5 | Insurance schedules returned and verified (gate 2) |
| 3–7 | Compliance questionnaire returned and scored (gate 3) |
| 5–8 | Rate card agreed and loaded (gate 4) |
| 7–9 | TMS record, portal logins and integration test (gate 5) |
| 10 | First tender; trial period begins (gate 6) |
| 10–40 | Ten monitored loads; trial review meeting |

## Gate 1 — Legal entity and operating authority

Collect the company registration number, VAT number and the operator licence. For UK carriers this is the standard national or standard international O-licence; for cross-border work it is the Community licence, and for EU-established carriers the equivalent national licence plus the Community licence certified copy that the vehicle will carry. Sole traders are accepted only for domestic work under 3.5 tonnes.

Check every number against the public register. Companies House for the entity (status must be active, no proposal to strike off, no outstanding overdue accounts flag), the VAT checker for the VAT number, and the Vehicle Operator Licensing register for the O-licence. Record the licence expiry date and the number of vehicles authorised; a carrier authorised for six vehicles that wants to run ten of our loads a day is a subcontracting risk and is flagged to the head of operations. The tracker raises a task 60 days before any licence lapses.

Confirm the trading name matches the name on the licence. A mismatch is usually innocent (a trading style) but it is also the pattern behind every unlicensed subcontractor we have found, so the compliance analyst asks for the link in writing and files it.

Subcontracting is not permitted without written consent. The information pack states this, the carrier agreement repeats it, and the TMS tender terms repeat it a third time. A carrier that intends to subcontract must name the subcontractor, who then goes through gates 1 to 3 in their own right.

Gate 1 is signed off by the carrier manager once the compliance analyst has confirmed all three register checks in the tracker.

## Gate 2 — Insurance

The minimum cover is set by the group insurance programme and is not negotiable at the carrier level. Where a customer contract demands more (pharmaceutical, high-value electronics, tobacco), the account manager tells the carrier manager before the carrier is put on that lane, and the higher limit is recorded against the lane in the TMS.

| Cover | Minimum | Notes |
| --- | --- | --- |
| Goods in transit | £100,000 per vehicle | Per-consignment limits are not acceptable; the policy must respond per vehicle load |
| Public liability | £5,000,000 | Any one occurrence |
| Employer's liability | £10,000,000 | Statutory; the certificate must be current |
| CMR liability | 8.33 SDR per kilogram | Mandatory for any international lane, including Ireland |
| Motor (third party) | Unlimited | Fleet policy schedule showing every vehicle that will carry our goods |

We accept a broker's letter confirming cover for the first 30 days, but the full policy schedule with the insurer's name, policy number, period of cover, limits and any warranties or exclusions must be on file before the second invoice is paid. Accounts payable will not release payment against a file where gate 2 shows a broker's letter older than 30 days.

Exclusions are read, not skimmed. Common problems: an unattended-vehicle warranty that voids goods-in-transit cover unless the vehicle is in a locked compound overnight (many of our lanes involve an overnight stop in a lay-by); a theft-from-vehicle exclusion for cigarettes or spirits; a limit per pallet that is lower than the value of a pallet of our customer's product. Where the exclusion conflicts with the work, the carrier either buys the extension or is not used on that lane.

Renewal dates are recorded in the tracker, which raises a task 45 days before expiry. A carrier whose insurance lapses is suspended in the TMS on the expiry date automatically and cannot be tendered until the compliance analyst uploads the renewed schedule.

Gate 2 is signed off by the compliance analyst.

## Gate 3 — Compliance questionnaire

The questionnaire is sent from the tracker on the day gate 1 opens and takes a competent operator about an hour. It is scored out of 100 by the carrier manager against the published scoring key; 70 is the pass mark, and any question marked as critical must be answered satisfactorily regardless of the overall score.

Critical questions:

1. A named transport manager holding a Certificate of Professional Competence, with the date of their most recent refresher training.
2. A written driver vetting policy covering licence checks (at least every six months, and every three months for drivers with six or more penalty points), right-to-work checks and driving-licence category verification.
3. Tachograph and working-time procedures: how card data is downloaded (at least every 28 days), how infringements are reported to the driver, and who reviews them.
4. A vehicle maintenance policy with inspection intervals no longer than those on the operator licence, a defect reporting system, and evidence that roadworthiness inspections are recorded and kept for fifteen months.
5. A written drug-and-alcohol policy that includes random testing. A carrier without one is not onboarded, no exceptions, and no amount of commercial pressure changes that.
6. A load security procedure covering strapping, curtain-sider restraint and load distribution for the trailer types they will use on our lanes.

Non-critical questions cover incident reporting, environmental accreditation, driver training beyond the legal minimum, telematics, the age profile of the fleet, and whether the carrier holds FORS, DVSA Earned Recognition or an equivalent scheme membership. Earned Recognition members skip the maintenance evidence request in question 4 because the scheme already audits it.

A carrier scoring between 60 and 69 may be onboarded for domestic ambient work only, with a re-score after three months; below 60 is a decline. Every decline is communicated in writing by the carrier manager with the scores, so the carrier can address the gaps and re-apply.

Gate 3 is signed off by the carrier manager.

## Gate 4 — Commercial terms

The rate card is agreed per lane, never as a blanket rate per mile. Each lane in the card names the origin site, the destination region or postcode area, the equipment type, the service level (next day, two day, timed) and the rate for a full load, a half load and a pallet. The card is valid for twelve months unless the fuel surcharge mechanism or a change in tolls triggers a review.

Fuel surcharge. The mechanism is the weekly published diesel price against a base price written into the card; the surcharge moves in 1% steps for every 2 pence per litre movement above or below the base. It is recalculated on the first Monday of each month and applied to invoices from that date. The carrier does not raise a separate fuel invoice.

Accessorial schedule. The following are the only chargeable extras; anything not in the table is included in the lane rate.

| Item | Charge | Conditions |
| --- | --- | --- |
| Waiting time | £35 per hour or part hour | After two hours free at each end, evidenced by TMS arrival and departure scan times |
| Redelivery | 50% of the lane rate | Where the failed delivery is not the carrier's fault; POD note or photograph required |
| Tail-lift | £25 per delivery | Only where the delivery address is flagged tail-lift in the TMS |
| Cancellation | 100% of the lane rate | Cancelled after the vehicle is dispatched; 50% if cancelled after 16:00 the day before |
| Timed delivery | £45 per delivery | Booked slot windows of two hours or less |
| Overnight | £60 per night | Multi-drop routes where the plan requires an overnight stop |

Payment terms are 45 days end of month under the self-billing agreement. We raise the invoice on the carrier's behalf from the POD scans in the TMS; the carrier receives a self-billing statement weekly and has fourteen days to query a line before it is treated as agreed. Carriers that will not accept self-billing are not onboarded, because the manual invoice matching cost exceeds the margin on most lanes.

Rates are loaded into the TMS by the pricing analyst, never by the carrier manager, and the loaded card is exported and emailed to the carrier for confirmation. A card that has been confirmed by the carrier in writing is the only card the TMS will tender against.

Gate 4 is signed off by the pricing analyst.

## Gate 5 — Systems

The TMS administrator creates the carrier record with the legal entity name, the O-licence number, the insurance expiry dates from gate 2, the lanes and equipment types from gate 4, and the contact hierarchy: a planner for tenders, an accounts contact for self-billing, and an out-of-hours number that is actually answered.

Portal logins are issued to the planner and the accounts contact. Before gate 5 closes the administrator walks the planner through a test tender: accept it, assign a vehicle and driver, add an ETA, upload a photograph of a POD, and find the remittance advice. The walkthrough is fifteen minutes on a call and prevents most of the first-week support tickets.

Telematics integration is optional for domestic ambient work and required for temperature-controlled lanes, where the trailer's reefer unit must report set point and return-air temperature to the TMS every fifteen minutes. The integration test is a 24-hour trace from one vehicle before the first temperature-controlled tender. Where the carrier's telematics provider is not on the supported list, the integration is scoped by the TMS administrator and the carrier is restricted to ambient work until it is live.

Electronic PODs are mandatory. The portal app captures a signature, a name, the time, the location and a photograph of the delivery; paper PODs are accepted only as a fallback when the app is unavailable and must be uploaded within 24 hours.

Gate 5 is signed off by the TMS administrator.

## Gate 6 — Trial period

The first ten loads are monitored daily by the carrier manager against four measures, and the results are shared with the carrier after loads five and ten.

| Measure | Target | Definition |
| --- | --- | --- |
| On-time collection | 95% | Arrival scan within the booked collection window |
| On-time delivery | 95% | Arrival scan within the booked delivery window |
| POD within 24 hours | 100% | Electronic POD available in the TMS within 24 hours of delivery |
| Claims | 0 | Any damage, shortage or loss claim raised on a trial load |

A carrier scoring under 90% on-time delivery in the trial is paused and reviewed with the head of operations before any further tenders. The review looks at the root cause of each failure: a carrier that missed windows because our sites loaded late is not penalised; a carrier that missed windows because it double-booked the vehicle is declined. A single claim on a trial load, where the carrier is at fault, ends the trial and the file is closed.

Carriers that pass the trial are moved from the trial tier to the standard tier in the TMS, which unlocks automatic tendering on their lanes. The carrier manager records the trial result and the date in the tracker, and the file is complete.

## Re-verification

Insurance and licence documents are re-collected annually, in the month the carrier was onboarded. The questionnaire is refreshed every two years, or immediately after any reportable incident — a roadside prohibition, a serious injury, a fatality, a fire, a theft of a loaded vehicle, or a customs seizure — whichever comes first. The re-verification is a shorter version of gates 1 to 3 and takes about three working days if the carrier is organised.

Performance is reviewed monthly from the TMS scorecard. A carrier that falls below 92% on-time delivery for two consecutive months moves back to the trial tier; a carrier that falls below 85% in any month is suspended pending a review with the head of operations.

## Exceptions and escalation

The only exceptions permitted are the re-sequencing of gates 4 and 5 for a carrier with an existing group framework agreement, and the use of a broker's letter for the first 30 days at gate 2. Both are recorded in the tracker with the approver's name. Everything else — a missing document, an unanswered critical question, a rate loaded from an unconfirmed card — is a hold, not an exception, and the load is tendered to another carrier while the hold is resolved.

Escalation path: carrier manager → head of operations → operations director. Nobody in the commercial team may instruct the carrier manager to release a hold; if a customer commitment depends on a carrier that is not yet onboarded, the commercial team's route is to the head of operations, who can arrange a temporary alternative from the standard tier.

## Document checklist

The file is complete when the tracker shows every item below with a document attached and a verification date.

1. Certificate of incorporation or equivalent, and the VAT registration certificate.
2. Operator licence (and Community licence for international work), with the register check screenshot.
3. Goods-in-transit, public liability, employer's liability and CMR policy schedules; motor fleet schedule.
4. The scored compliance questionnaire and any supporting policies requested.
5. The confirmed rate card export, the accessorial schedule acknowledgement and the signed self-billing agreement.
6. Bank details verified by a call-back to a number taken from the carrier's website, not from the email that supplied the details.
7. The TMS carrier record reference, the portal user list and, where applicable, the telematics integration test trace.
8. The trial period scorecard and the head of operations' sign-off where a review took place.

## Version history

| Version | Date | Change |
| --- | --- | --- |
| 4.2 | 1 June | Bank verification call-back added to the document checklist after the payment diversion attempt in April; waiting-time rate increased from £30 to £35 |
| 4.1 | 14 February | Earned Recognition members exempted from the maintenance evidence request |
| 4.0 | 3 September (prior year) | Trial period extended from five to ten loads; claims measure added |
| 3.6 | 22 March (prior year) | CMR insurance made mandatory for Ireland following the Holyhead claim |`,
  },
  {
    key: 'warehouse-safety-audit',
    title: 'Q3 warehouse safety audit',
    createdDaysAgo: 9,
    text: `# Q3 warehouse safety audit — Leeds distribution centre

Audit date: 18 July. Auditor: regional H&S lead, accompanied by the site manager and the union safety representative. Scope: racking, mechanical handling equipment, pedestrian segregation, fire systems, first aid, hazardous substances and training records. Overall rating: amber — two major findings, five minor findings, no immediate-danger findings.

## Site summary

The Leeds distribution centre is a 22,000 square metre ambient warehouse with 14 dock doors, 11 aisles of adjustable pallet racking (APR) up to 11 metres, a mezzanine pick module over aisles 1 to 3, a battery charging area for 26 counterbalance and reach trucks, and a marshalling area of 1,800 square metres in front of doors 1 to 8. It operates three shifts, five days a week, with a Saturday day shift in peak. Headcount on the audit day was 138 warehouse staff, 9 shift supervisors and 11 agency workers.

The previous audit (Q1, 19 March) rated the site green with three minor findings, all closed. The site has had one RIDDOR-reportable injury in the last twelve months (a fractured wrist from a fall on the mezzanine stairs in November), 14 recorded near-misses and 31 first-aid-only incidents.

## Rating method

Findings are graded against the group standard. An immediate-danger finding stops the activity until it is made safe. A major finding is a breach of a legal duty or of a group critical control that could plausibly lead to a serious injury; it has a named owner and a due date within 90 days. A minor finding is a lapse in a procedure or record that does not on its own create a serious risk; it is closed by the site within 30 days without a separate closure report. The overall rating is red for any immediate-danger finding or three or more majors, amber for one or two majors, green otherwise.

## Method

The audit followed the group protocol: a document review on the morning of 17 July (previous audit report, incident and near-miss log, MHE maintenance records, fire alarm and extinguisher registers, training matrix, COSHH register and the site traffic management plan), then a full day on the floor on 18 July covering every aisle, the mezzanine, the charging area, the marshalling area, the yard and the welfare block. Twelve staff were interviewed informally during the walk — four MHE operators, three pickers, two goods-in operatives, a mezzanine supervisor, a cleaner and an agency worker in their second week — and their answers are reflected in the findings where relevant. Nothing in this report relies on a single interview.

Sampling: 30 MHE shifts across ten trucks for pre-use checks, 20 warehouse staff and all nine supervisors for training records, every extinguisher and call point for the fire systems, and all 71 aisle ends for upright protectors. Where a sample is quoted below the sample size is stated.

## Near-miss log, quarter to date

The site recorded 14 near-misses between 1 April and 17 July, against 9 in the previous quarter. The increase is not in itself a concern — the site ran a reporting campaign in May — but the two pedestrian incidents at the loading doors are the subject of major finding 2.

| Date | Area | Description | Category |
| --- | --- | --- | --- |
| 3 April | Aisle 4 | Pallet overhanging the beam by 15 cm, noticed by a picker | Storage |
| 11 April | Yard | Trailer moved with the dock leveller still engaged | Vehicle |
| 24 April | Mezzanine | Tote fell from the conveyor onto the walkway below | Falling object |
| 2 May | Aisle 9 | Reach truck struck an upright at bay 14; reported by the operator | Racking impact |
| 9 May | Goods-in | Pallet wrap knife left open on a bench | Sharps |
| 16 May | Aisle 7 | Pedestrian in the aisle while a reach truck was lifting | Segregation |
| 23 May | Charging area | Water on the floor from a leaking battery topping bottle | Slip |
| 30 May | Yard | Driver walked behind a reversing shunter | Vehicle |
| 4 June | Doors 6–7 | Counterbalance truck reversing stopped within a metre of a pedestrian | Segregation |
| 8 June | Aisle 11 | Pallet found with a broken bottom board on the top beam | Storage |
| 14 June | Mezzanine | Fire exit partially blocked by empty totes | Fire |
| 21 June | Doors 6–7 | Pedestrian stepped in front of a reach truck with a raised load | Segregation |
| 2 July | Aisle 2 | Operator found a damaged wooden pallet had been stored at height | Storage |
| 15 July | Goods-out | Stretch wrap machine turntable started with a hand on the pallet | Machinery |

Only one of the two aisle 9 racking impacts noted during the audit appears in the log, which is discussed under major finding 1.

## Major finding 1 — Racking damage

Fourteen upright protectors were missing or displaced in aisles 7 to 11, and three uprights showed dents beyond the SEMA amber threshold (two in aisle 9 at bay 14, one in aisle 11 at bay 3). One of the aisle 9 uprights also had a twisted bracing member. The bays were offloaded and tagged out during the audit, and the site manager confirmed by the end of the day that the tagged locations had been blocked in the warehouse management system so they could not be allocated.

The weekly racking inspection by the shift supervisor, required by the group standard and the site's own procedure, had lapsed since April. The last recorded inspection sheet was dated 9 April; the supervisor who had carried it out moved to the Wakefield site that month and the task was not reassigned. The annual inspection by the SEMA-approved inspector was carried out on schedule in February and found no damage above the green threshold, which suggests most of the damage is recent and consistent with the peak volume through May and June.

Action:

1. Replace the three damaged uprights and the bracing member. A SEMA-approved inspector to confirm the repair before the bays are returned to use.
2. Refit or replace the fourteen upright protectors and audit every aisle end for protector condition.
3. Reinstate the weekly racking inspection: reassign the task in the shift supervisor rota, and add it to the site's compliance calendar so a lapse is visible within a week.
4. Re-brief every MHE operator on the requirement to report a racking impact immediately, and review the last three months of impact sensor data from the reach trucks for unreported strikes.

Owner: site manager. Due: 15 August. Interim control: the tagged bays remain out of use; supervisors carry out a documented racking walk at the start of every shift until the weekly inspection is re-established.

## Major finding 2 — Pedestrian segregation at the loading doors

The marked walkway from the canteen to the goods-out office crosses the forklift route at the loading doors (between doors 6 and 7) without a barrier or a controlled crossing. The crossing is used by every member of staff going to and from the canteen and by visitors being escorted to the office. Two near-misses were reported in June: on 4 June a counterbalance truck reversing from door 7 stopped within a metre of a pedestrian, and on 21 June a pedestrian stepped onto the route in front of a reach truck travelling with a raised load.

The route was created when the goods-out office was relocated in January, and the segregation plan from the original layout was not updated. The walkway markings are clear but there is no physical separation, no mirror at the blind corner formed by the door 7 stack, and the pedestrian is not visible to a driver reversing from the dock.

Action:

1. Install a barrier-gated crossing with a convex mirror and a warning beacon linked to the gate, so a pedestrian must stop and open the gate to enter the route and a driver sees the beacon.
2. Re-route the walkway behind the marshalling area as the permanent fix, using the existing fire exit corridor along the north wall, and remove the crossing at doors 6 and 7 entirely.
3. Update the site traffic management plan and re-issue it to every MHE operator and to the agency induction pack.

Owner: regional operations director. Due: 30 September. Interim control: from 19 July the crossing is manned by a banksman during shift changes and breaks, and the doors 6 and 7 route is one-way for MHE.

## Minor findings

1. Forklift pre-use checklists were completed for only 71% of shifts in the audit sample (30 shifts across ten trucks). The checks are done on the truck's keypad; several operators had logged in with a shared PIN, which the supervisor believed to be a training account. Action: disable the shared PIN, re-issue individual PINs, and report completion weekly. Owner: MHE coordinator.
2. Two fire extinguishers were past their service date — the CO2 extinguisher at the battery charging area (due May) and the foam extinguisher at the goods-in office (due June). Action: service both and reconcile the extinguisher register against the contractor's service schedule. Owner: site facilities lead.
3. The eyewash station in the battery charging area was empty, and the bottle-type eyewash at the first-aid point had expired. Action: refill, replace, and add both to the weekly first-aid check. Owner: site facilities lead.
4. Three new starters (two agency, one direct) had no record of manual handling training, although all three had completed the site induction. Action: deliver the training within a week and check that the induction checklist includes the manual handling module. Owner: shift supervisor, day shift.
5. The spill kit at bay 4 was missing absorbent pads and the disposal bags. Action: restock and add spill kits to the weekly walk. Owner: site facilities lead.

## Mechanical handling equipment

The site operates 12 reach trucks, 10 counterbalance trucks, four pedestrian pallet trucks and two order pickers on the mezzanine, all on a full-maintenance lease. Thorough examination certificates under LOLER were current for every truck; the six-monthly examinations for the reach trucks fall due in September and are booked. Two counterbalance trucks had worn fork heels within 10% of the wear limit and are scheduled for replacement forks at the next service. Impact sensors are fitted to every reach truck and the data is downloaded monthly by the lease company; the site does not review it, which is addressed under major finding 1.

Speed limiters are set to 8 km/h inside and 12 km/h in the yard; a random check of four trucks confirmed the settings. Seat belts were worn by every counterbalance operator observed. Blue spot warning lights were fitted and working on every truck checked.

## Fire systems

The site has an addressable fire alarm with 58 manual call points, automatic smoke detection in the offices and the mezzanine, and beam detection across the main warehouse. The weekly test log was complete for the quarter and rotated through the call points as required. The six-monthly service by the alarm contractor was carried out on 12 June with no defects. Emergency lighting was tested monthly and the annual three-hour discharge test was recorded on 4 May with two fittings replaced.

There are 94 extinguishers on the register. All were present and accessible during the walk, and all but the two noted under minor finding 2 were within their service date. The register itself listed 96 units; two were removed when the old goods-in office was demolished and the register was not updated, which the facilities lead corrected during the audit.

Fire exits were clear on the day of the audit. The near-miss of 14 June (totes at a mezzanine exit) had been dealt with by moving the tote drop point, and the supervisor confirmed the exit is now on the hourly mezzanine walk.

## Hazardous substances

The COSHH register lists 23 products, mainly cleaning chemicals, battery electrolyte, adhesives for the labelling machines and diesel for the yard shunter. Safety data sheets were on file and current for every product checked (ten sampled). Battery topping is done with deionised water from a bottle, and the leak of 23 May led to a spill tray being fitted under the storage rack. The battery charging area has the correct signage, a hydrogen detector with a weekly recorded test, and an acid-resistant floor in good condition. Personal protective equipment for battery work — face shield, gauntlets and apron — was available and in good condition, though one operator interviewed said the face shield was rarely used for a quick top-up; the MHE coordinator will re-brief the charging procedure.

## First aid

Twelve first aiders are nominated across the three shifts, giving a minimum of two per shift including Saturdays. First-aid kits at five points were checked; all were stocked apart from the expired eyewash noted under minor finding 3. The defibrillator in the reception was tested and its pads are in date until next February. The accident book is kept in the shift office and the 31 first-aid-only incidents this year are dominated by cuts from wrap knives and box cutters, which the site has already addressed by moving to safety knives with retracting blades in May; June and July show a reduction.

## Positive observations

Charging-area ventilation was compliant with the hydrogen extraction rate on the design certificate, and the gas detection alarm test was recorded weekly. The fire alarm test log was complete for the whole quarter, with the weekly call point rotation followed. The high-visibility policy was followed by every person observed on the floor, including visitors and drivers. The mezzanine edge protection installed after the November injury was in good condition, and the stair nosings had been replaced with the high-contrast type.

## Observations outside the scope

The auditor noted that the yard traffic plan does not cover the new trailer parking area on the east side, where drivers walk between parked trailers to reach the driver waiting room. This will be included in the Q4 scope. The site also raised a concern about noise levels on the mezzanine from the new conveyor, and a noise survey has been requested from the group hygiene contractor.

## Training records

Records were sampled for 20 of the 138 warehouse staff and all nine supervisors. MHE licences were current for every sampled operator. Fire warden training was current for all nine supervisors. First-aid-at-work certificates were current for eleven of the twelve nominated first aiders; the twelfth expired on 30 June and a refresher is booked for 2 August. Manual handling training records were missing for the three new starters noted above; every other sampled record was complete.

## Next steps

The site manager submits a closure report with photographs for each major action by the due date. The regional lead re-audits the two major findings within 30 days of their due dates and confirms closure in the group system. Minor findings are closed by the site within 30 days and verified at the Q4 audit. The Q4 audit, provisionally 15 October, will add racking load notices, mezzanine edge protection, the east yard traffic plan and the conveyor noise survey to the scope.

## Action tracker

| Ref | Finding | Owner | Due | Status at issue |
| --- | --- | --- | --- | --- |
| MAJ-1 | Racking damage, aisles 7–11 | Site manager | 15 August | Open — interim controls in place |
| MAJ-2 | Pedestrian crossing at doors 6–7 | Regional operations director | 30 September | Open — banksman at shift changes |
| MIN-1 | Pre-use checklist completion 71% | MHE coordinator | 17 August | Open |
| MIN-2 | Two extinguishers past service | Site facilities lead | 17 August | Closed 20 July |
| MIN-3 | Eyewash station empty | Site facilities lead | 17 August | Closed 19 July |
| MIN-4 | Manual handling training, three starters | Day shift supervisor | 25 July | Open — booked 23 July |
| MIN-5 | Spill kit at bay 4 | Site facilities lead | 17 August | Closed 19 July |

Distribution: site manager, regional operations director, group H&S manager, union safety representative, site facilities lead. Report issued 22 July.`,
  },
  {
    key: 'customs-eu',
    title: 'Customs paperwork: EU shipments',
    createdDaysAgo: 7,
    text: `# Customs paperwork: EU shipments

Operating guide, version 7. Owner: Export Coordination. Applies to every consignment leaving a UK site for a customer in the European Union, whether it moves by accompanied trailer through the short-straits ports, unaccompanied through Hull or Immingham, or by groupage through the pallet network's Dover hub. It covers which documents each shipment needs, who prepares and signs them, and the checks that stop a truck being held at the border. It does not cover excise goods (alcohol, tobacco), controlled products (dual-use, firearms, precursor chemicals), goods moving to Northern Ireland under the Windsor Framework, or returns coming back into the UK — each has its own procedure in the document store.

## Why this matters

Since January 2021 every consignment to the EU is an export from the UK and an import into the member state of destination. A truck arriving at a port without the right documents is refused at check-in, misses its sailing and sits in a holding compound at our cost; a consignment arriving at the destination with paperwork that does not match the goods is inspected, delayed and sometimes assessed for duty that should not have been due. In the last full year we logged 61 customs incidents. Forty-four were avoidable with the checks in this guide, and the direct cost of those forty-four — re-bookings, demurrage, duty reclaims we could not recover, and credits to customers — was a little over £71,000. That is the case for doing every step every time.

## Roles

| Role | In this procedure |
| --- | --- |
| Customer service desk | Prepares the commercial invoice from the sales order; applies the statement on origin to qualifying SKUs |
| Customer service lead | Signs the commercial invoice |
| Warehouse shift supervisor | Signs the packing list; confirms marks, weights and pallet counts |
| Export coordinator | Books the movement, requests the export declaration, receives the MRN, prints the CMR, runs the pre-departure checklist, releases the vehicle |
| Customs broker (external) | Lodges the export declaration on CDS; for DDP sales, lodges the import declaration through our EU fiscal representative |
| Product compliance analyst | Maintains the list of SKUs that qualify for preferential origin; approves additions |
| DG signatory | The only person who may sign a dangerous goods note |
| Pricing team | Approves DDP pricing before a DDP order is accepted |
| Haulier | Obtains the GVMS goods movement reference for the sailing; the driver carries and signs the CMR |

## Incoterms we sell on

We quote EU customers on three terms only, and the term drives who does what below.

| Term | What it means for paperwork |
| --- | --- |
| EXW (ex works) | The customer's haulier collects; the customer's broker handles the export declaration. We still prepare the invoice and packing list. Discouraged — we lose control of the proof of export needed for zero-rating |
| DAP (delivered at place) | Our haulier delivers; we handle the export; the customer's broker handles the import and the customer pays the import VAT and any duty. The default term |
| DDP (delivered duty paid) | As DAP, plus our broker lodges the import declaration through our fiscal representative and we pay the import VAT and duty, which are invoiced back to us. Only with pricing team approval |

## Documents required for every EU shipment

Commercial invoice. Prepared by the customer service desk from the sales order in the ERP; the template is the only acceptable format. It must show the seller and buyer with their EORI numbers (ours begins GB, the customer's with their member state code), the Incoterm and named place, a line-by-line description in plain language — "stainless steel hose clamps, 40–60 mm" rather than a part number alone — with commodity codes (HS codes at eight digits for export, ten digits for the importer where the customer has supplied them), country of origin per line, unit and total values, currency, net and gross weight, the number of packages, and the invoice number that the export declaration will reference. The customer service lead signs it. An invoice showing "samples, no commercial value" is not acceptable: every line carries a value for customs purposes even when nothing is charged.

Packing list. Prepared by the warehouse at the point of picking, from the pick confirmation in the WMS. It lists every carton and pallet with dimensions, gross and net weight, the pallet identifier and the marks and numbers that appear on the labels, and it cross-references the invoice line each carton belongs to. The warehouse shift supervisor signs it, and the totals must match the invoice exactly — the same number of packages, the same gross weight to the kilogram. A mismatch is the most common reason for a query at the port, and the second most common reason for a physical inspection at the destination.

Export declaration. Submitted through our customs broker on the Customs Declaration Service before the goods leave the site. The broker needs the invoice, the packing list and the transport details: haulier, vehicle registration, trailer number, port of exit and sailing. The Movement Reference Number the broker returns goes on the CMR and is emailed to the haulier. The export coordinator is responsible for submitting the request to the broker and for confirming the MRN is back before the collection time; the broker's service level is two hours for a standard declaration during office hours and four hours out of hours. A request submitted after 15:00 for a collection before 09:00 the next day must be flagged to the broker by telephone.

CMR consignment note. Four copies, printed by the export coordinator from the TMS: one for the sender, one for the consignee, one for the haulier and one that travels with the goods for customs. Box 1 sender, box 2 consignee, box 3 place of delivery, box 4 place and date of taking over, box 5 attached documents (invoice number, packing list, MRN), boxes 6 to 12 the goods (marks, number of packages, method of packing, nature of goods, statistical number, gross weight, volume), and box 13 the sender's instructions including the customs office of exit. The driver signs on collection and keeps two copies; the consignee signs the delivery copy, which the haulier returns to us as the proof of export. A CMR without the MRN in box 5 is incomplete.

Import declaration. Lodged in the destination member state by the importer's broker, using the invoice and packing list we send with the goods and the transit or export data. Under DAP this is the customer's responsibility and we hear about it only when it goes wrong. Under DDP our broker lodges it through our EU fiscal representative in the Netherlands, and the import VAT and duty are invoiced back to us on the fiscal representative's monthly statement, so the pricing team must have approved the DDP rate before the order is accepted.

Proof of origin. Where the goods qualify for preferential duty under the Trade and Cooperation Agreement, the invoice carries the statement on origin — the prescribed wording with our REX or EORI number — and the customer's broker uses it to claim zero duty at import. The product compliance analyst decides whether a product qualifies, from the bill of materials and the supplier declarations on file, and maintains the list of qualifying SKUs in the ERP. Customer service must not add the statement to a product that is not on the list; an incorrect statement on origin is a customs offence in the destination country, and the customer bears the duty and the penalty and then claims both from us.

## Additional documents by product type

Food and animal-origin products need an export health certificate signed by an official veterinarian, issued through the export health certificate service, and the importer must pre-notify the consignment in TRACES at least one working day before arrival. The certificate must travel with the goods in original, not as a copy; a consignment arriving at a border control post without it is destroyed or returned at our cost. Composite products and products of non-animal origin under safeguard measures have their own certificate requirements, which the product compliance analyst confirms per SKU.

Wood packaging must be ISPM 15 stamped — every pallet, every crate, every dunnage timber. The warehouse checks the stamp at picking and swaps any unstamped pallet for a heat-treated one from the export stock; a consignment on unstamped pallets is refused at the destination port and the pallets must be replaced or destroyed there.

Dangerous goods need a dangerous goods note signed by the trained DG signatory, and the haulier must be ADR-approved for the class carried and the driver must hold an ADR certificate. The packaging must carry the UN marking and the labels for the class, and the CMR must show the UN number, proper shipping name, class and packing group. Aerosols, lithium batteries in equipment, and the flammable adhesives in the labelling range are the products most often shipped without recognising they are dangerous goods; the ERP flags them, and a flagged SKU cannot be released to picking without the DG note number recorded against the order.

Safety data sheets accompany chemicals in the language of the destination; the product compliance analyst holds the translated sheets and customer service attaches the right one to the shipment folder.

Products subject to CE or UKCA marking need the EU declaration of conformity available on request; it does not travel with the goods but the importer will ask for it, and the compliance analyst keeps the current version per product family.

## Who signs what

Commercial invoice: customer service lead. Packing list: warehouse shift supervisor. Export declaration request: export coordinator. CMR: the driver on collection, the consignee on delivery. Dangerous goods note: the DG signatory only. Statement on origin: the product compliance analyst approves the SKU list; customer service applies it. Export health certificate: the official veterinarian; the export coordinator books the inspection. DDP pricing approval: the pricing team, recorded on the sales order before acceptance. Nobody signs on behalf of somebody else; a document signed by the wrong role is treated as unsigned and the vehicle is held.

## Pre-departure checks

The export coordinator runs the checklist before releasing a vehicle, from the TMS release screen, and the release cannot be confirmed until every item is ticked:

1. Invoice and packing list totals agree — packages, gross weight, and the invoice number quoted on the packing list.
2. EORI numbers present for both parties, and the customer's EORI validated in the EU database within the last twelve months.
3. Commodity codes present on every invoice line and in the format the destination expects.
4. MRN received from the broker and written in box 5 of the CMR.
5. The driver has all four CMR copies and a copy of the invoice and packing list in the document wallet.
6. The haulier has the GVMS goods movement reference for the sailing, and the MRN is included in it.
7. Any export health certificate, dangerous goods note or safety data sheet is in the document wallet in original.
8. Every pallet carries the ISPM 15 stamp.
9. For DDP orders, the fiscal representative has been notified and the pricing approval is on the sales order.
10. The seal number is recorded on the CMR and in the TMS.

A vehicle that fails a check is held, not released with a promise to fix it in transit. The export coordinator informs the customer service desk, who tell the customer of the revised collection, and the haulier is told immediately so the vehicle can be re-planned. A hold is never the driver's problem to solve at the port.

## Common failures and what they cost

A missing MRN means the vehicle is refused at check-in and misses the sailing — typically a 24-hour delay and a re-booking fee of between £150 and £400 depending on the route, plus the driver's waiting time. A packing-list mismatch triggers a physical inspection at the port of entry, which averages two days and costs an inspection fee, storage and, for chilled goods, sometimes the load. A missing statement on origin means the customer pays full duty — between 1.7% and 6.5% on most of our range — and raises a claim against us for the difference, which we cannot recover from anybody. An unstamped pallet costs the replacement pallet, the re-palletising labour at the destination and a day. A dangerous goods consignment shipped without a DG note is refused by the ferry operator, and the haulier may be fined; it has happened twice, both times with aerosols.

Each of these is logged as a customs incident in the TMS with the root cause and the cost, and reviewed at the monthly operations meeting.

| Failure | Typical delay | Typical direct cost |
| --- | --- | --- |
| Missing or wrong MRN | 24 hours | £150–£400 re-booking plus waiting time |
| Packing list does not match invoice | 2 days | Inspection fee, storage, possible loss of chilled goods |
| Missing statement on origin | None at the border | Duty at 1.7%–6.5% of invoice value, claimed back by the customer |
| Unstamped wood packaging | 1 day | Replacement pallets and re-palletising at destination |
| Dangerous goods without a DG note | Refused sailing | Re-booking, possible haulier fine, re-packaging |
| Invoice without values ("samples") | 1–3 days | Valuation query at import, duty assessed on an estimated value |

## Worked example — a DAP delivery to Lyon

A customer in Lyon orders 14 pallets of hose clamps and 2 pallets of adhesive on Monday for delivery the following Monday, DAP their site. Tuesday: customer service raises the invoice from the sales order; the adhesive is flagged as a class 3 dangerous good, so the order cannot be released to picking until the DG signatory has issued the note. Wednesday: the DG note is issued, the order is picked, the warehouse checks the ISPM stamps and prints and signs the packing list, and the export coordinator books the haulier for a Thursday 14:00 collection and a Friday 06:00 Dover sailing. Wednesday 15:30: the export coordinator sends the invoice, packing list, DG note and transport details to the broker. Thursday 09:10: the broker returns the MRN; the coordinator writes it on the CMR, emails it to the haulier, and the haulier adds it to the GVMS reference for the sailing. Thursday 13:45: the driver arrives, the coordinator runs the ten-point release checklist, the driver signs the CMR and leaves with the document wallet. Friday: the vehicle checks in at Dover with the GVMS reference, sails, and the export declaration is departed automatically. Monday: the goods are delivered; the customer's broker has already lodged the import declaration using the invoice and the statement on origin, so no duty is due. Tuesday: the haulier uploads the signed CMR to the portal and the shipment folder is complete. Total paperwork time: about 90 minutes across four people.

## Worked example — what went wrong in March

The same customer, same products, March. The order was taken on a Thursday for a Monday delivery. The invoice was raised on Friday morning, but the adhesive's DG flag was overridden by a supervisor "to get it picked" because the DG signatory was on leave; no DG note was issued. The broker request went in at 16:20 on Friday for a Saturday collection, so the MRN did not arrive until Saturday 10:00 and the driver had already left with a CMR that had no MRN in box 5. The haulier's GVMS reference therefore carried no MRN, the vehicle was refused at Dover check-in on Saturday afternoon, and by the time the MRN was added the Saturday sailings were full. The vehicle sailed on Sunday evening; on arrival at the customer the packing list showed 16 pallets and the invoice 15 (one adhesive pallet had been split at picking), and the customer's broker held the delivery for a physical inspection, during which the missing DG note was noticed. The goods were delivered on Wednesday, two days late. Cost: £320 re-booking, two days of driver waiting time, an inspection fee, a €1,500 penalty for the undeclared dangerous goods, and a credit note to the customer. Three of the ten release checks would have stopped it.

## Groupage and the pallet network

Consignments of fewer than six pallets usually travel by groupage through the pallet network's Dover hub, where they are consolidated onto a trailer with other shippers' goods. The paperwork is identical — invoice, packing list, export declaration, MRN — but the network lodges one consolidated GVMS reference for the trailer, so our MRN must reach the network by 14:00 on the day of collection or the consignment is held at the hub for the next departure. The CMR for a groupage consignment is the network's consignment note, and the proof of export is the network's signed delivery record, which the export coordinator downloads from the network portal and files with the shipment.

## Record keeping

Every document is kept for six years from the end of the year of shipment, in the shipment folder in the document store, named with the sales order number. The customs broker keeps the declarations, but we keep our own copy of the MRN and the signed CMR because they are what HMRC asks for in a zero-rating audit: to zero-rate an export for VAT we must hold evidence that the goods left the UK within three months of the sale, and a signed CMR with the MRN is that evidence. A shipment folder without a signed CMR is chased by the export coordinator at 30 days and escalated to the haulier's account manager at 45 days.

## Contacts and escalation

Broker out-of-hours line, fiscal representative, the pallet network customs desk and the ADR consultant are in the contacts sheet in the document store. Escalation for a held vehicle: export coordinator → customer service lead → head of operations. Escalation for a customs incident with a cost over £2,000: head of operations → finance director, on the day.`,
  },
  {
    key: 'fleet-maintenance',
    title: 'Fleet maintenance schedule',
    createdDaysAgo: 5,
    text: `# Fleet maintenance schedule

Version 3.1 — effective 1 April. Owner: Fleet Engineering. Review: annually with the operator licence undertakings, or after any change to the fleet profile, the maintenance provider or the inspection intervals agreed with the traffic commissioner.

The owned fleet is 42 tractor units, 18 rigid trucks and 71 trailers, maintained under the operator licence undertakings. The schedule below is the minimum; the fleet engineer may bring an inspection forward after a defect report or a roadside stop, never push one back. Every interval in this document is the one declared on the operator licence, and a change to any of them is a variation application to the traffic commissioner before it is a change to the workshop calendar.

## Fleet profile

| Type | Count | Typical age | Maintained by |
| --- | --- | --- | --- |
| 44-tonne tractor units | 42 | 2.8 years | In-house workshop, Wakefield |
| 18-tonne rigids (curtain-side, tail-lift) | 12 | 3.5 years | In-house workshop, Wakefield |
| 26-tonne rigids (refrigerated) | 6 | 2.1 years | In-house workshop; reefer units by the manufacturer's agent |
| Curtain-side trailers | 48 | 5.2 years | In-house workshop |
| Refrigerated trailers | 15 | 3.9 years | In-house workshop; reefer units by the manufacturer's agent |
| Box and double-deck trailers | 8 | 6.0 years | Contracted to the trailer manufacturer's service network |

Vehicles are replaced on a five-year cycle for tractor units and seven years for rigids; trailers are assessed at eight years and replaced at ten unless the annual inspection history is clean. The replacement plan is reviewed each January with the finance team.

## Daily — driver walk-around check

The driver completes the walk-around check before the first journey of the day and records it in the defect app, which timestamps and geolocates the check and will not let a journey be started in the tachograph-linked planning app until the check is complete. The check takes about ten minutes for a tractor unit and trailer and covers:

1. Lights, indicators, reflectors and number plate illumination.
2. Tyres — visible damage, tread, inflation — and wheel nuts, using the indicator tabs; a missing or misaligned tab is a defect.
3. Mirrors, cameras and the windscreen (no chips in the driver's sweep).
4. Brakes — pedal feel, air pressure build-up and warning lights; parking brake hold on the gradient at the yard exit.
5. Fluid levels and leaks — oil, coolant, AdBlue, washer fluid; any drip under the vehicle.
6. Load security — curtains, straps, internals, the trailer floor and the load itself where accessible.
7. Tachograph — card inserted, time correct, no fault warnings; the printer has paper.
8. The trailer coupling — fifth wheel locked, the dog clip in place, the air and electrical lines connected and secured, the landing legs raised.
9. Reefer units — set point matches the load plan, pre-trip check passed, fuel above a quarter.
10. Cab — seat belt, horn, wipers, heater and demister, fire extinguisher and first-aid kit in date, the ADR kit where the vehicle is ADR-equipped.

A defect that affects safety takes the vehicle off the road until a technician signs it off in the app; the driver reports it to the transport office, who reassign the load. A defect that does not affect safety — a cracked mirror casing, a worn seat cover — is logged and repaired at the next scheduled visit. The app classifies each item as safety-critical or not; a driver may not downgrade a safety-critical item.

Drivers are re-briefed on the walk-around every six months, and the fleet engineer audits a sample of ten checks a week against the vehicle's actual condition. A driver whose recorded check does not match a defect found the same day by a technician is spoken to by the transport manager and the conversation is recorded.

## Six-weekly — safety inspection

Every tractor unit and rigid receives a safety inspection by the workshop every six weeks, on the fixed calendar published each January. The calendar is built around vehicle availability and is the only authority for when an inspection is due; a vehicle that misses its slot is not driven again until it is inspected, and the transport office knows a week in advance which vehicles are out. Trailers are inspected every eight weeks on the same basis.

The inspection follows the DVSA inspection manual and the workshop's inspection sheet, which mirrors it item by item, and it includes a brake performance test on the roller brake tester at every inspection, laden where possible. A laden test means the vehicle is presented with at least 65% of its design axle weights; where that cannot be arranged, the test is carried out unladen and the reason is recorded, and the next test must be laden. A vehicle whose brake test falls below the pass threshold does not leave the workshop.

Inspection sheets are kept for fifteen months and are available to the traffic commissioner or a DVSA examiner on request. Every sheet shows the technician, the mileage, every item checked, every defect found and the rectification, and the brake test printout is stapled to it. The fleet engineer reviews and countersigns every sheet within a week.

## Annual and periodic

MOT for every vehicle and trailer, scheduled four weeks before expiry so that a failure can be rectified and retested without the vehicle running out of test. The pre-MOT preparation is a full safety inspection, which counts as one of the six-weekly inspections.

Tachograph calibration every two years at an approved centre, and any time the vehicle is re-plated, the gearbox is replaced, the tyre size on the driven axle changes, or the tachograph unit is replaced. The calibration plaque is checked at every safety inspection.

Tail-lift LOLER thorough examination every six months by the lifting equipment inspector; the report is filed with the vehicle and a copy is carried in the cab. A tail-lift with an open defect is isolated and the vehicle is used for non-tail-lift work only.

Speed limiter check annually and at the tachograph calibration.

Refrigeration unit service every 1,500 running hours or six months, whichever is first, by the manufacturer's agent; a temperature calibration check is recorded at every service and the certificate goes in the trailer file for pharmaceutical and food customers, who ask for it at their own audits. Reefer units are also pre-trip checked by the driver daily and by the workshop at every trailer inspection.

Fire extinguishers in every cab are serviced annually; first-aid kits are checked at every safety inspection.

| Item | Interval | Who |
| --- | --- | --- |
| Driver walk-around | Daily, before the first journey | Driver |
| Safety inspection — tractors and rigids | 6 weeks | Workshop |
| Safety inspection — trailers | 8 weeks | Workshop |
| Roller brake test | At every safety inspection | Workshop |
| MOT | Annual, booked 4 weeks before expiry | Workshop presents |
| Tachograph calibration | 2 years, or on re-plating / gearbox / tyre size change | Approved centre |
| Tail-lift thorough examination | 6 months | Lifting equipment inspector |
| Speed limiter check | Annual | Workshop |
| Reefer unit service and temperature calibration | 1,500 hours or 6 months | Manufacturer's agent |
| Cab fire extinguisher | Annual | Contractor |

## Tyres

Minimum tread of 3 mm on steer axles, 2 mm elsewhere (above the legal 1 mm) — replaced at the next inspection once the threshold is reached, and immediately where the tyre is at the legal limit or shows damage to the sidewall, cords or bead. Tyre pressures are checked at every safety inspection and by the driver weekly with the cab gauge. Retreads are permitted on drive and trailer axles only, never on steer axles, and only from the two approved suppliers whose retreads are marked and traceable.

Tyre management is contracted: the supplier's fitter attends the yard on Tuesdays and Thursdays, replaces tyres flagged at inspection, and carries out a fleet tread survey monthly. The survey report goes to the fleet engineer, who uses it to forecast replacements and to spot uneven wear that points to an alignment or suspension fault.

Wheel security: every wheel removal is recorded in the wheel security log with the torque applied, and the wheel nuts are re-torqued after 50 to 100 km by the workshop or the tyre fitter, recorded again. The indicator tabs are fitted to every wheel and checked by the driver daily.

## Refrigeration units

The 15 refrigerated trailers and six refrigerated rigids carry chilled and frozen food and, on two dedicated trailers, pharmaceutical products under a quality agreement with the customer. Both the trailer body and the unit are on the maintenance schedule: the unit under the 1,500-hour service above, the body for door seals, floor condition, drain holes, bulkhead integrity and the internal temperature probes.

Temperature records are downloaded from the unit at every service and kept for two years; for the pharmaceutical trailers, the records are downloaded after every journey and sent to the customer's quality team monthly. A unit that cannot hold set point within 2 degrees during the pre-trip check is not dispatched.

## Defects and downtime

Every defect — from a driver's walk-around, a safety inspection, a roadside stop or a breakdown — is closed in the app with the technician, the parts used and the time taken. A defect is not closed by a driver; the app requires a technician login to sign off a safety-critical item, and a non-critical item is closed when the repair is recorded at the next workshop visit.

Vehicle-off-road hours are reported weekly to the head of operations; the target is below 4% of available hours across the fleet, and the workshop reports by vehicle type so a problem in one model shows up early. Recurring defects are reviewed at the monthly fleet meeting; a defect that recurs three times on the same vehicle triggers a root-cause investigation by the fleet engineer, and a defect that recurs across three vehicles of the same model is raised with the manufacturer.

Breakdowns are managed through the manufacturer's roadside assistance for tractor units and the contracted breakdown provider for trailers. The transport office logs every breakdown with the time reported, the time attended and the time cleared; the provider's contracted attendance time is 90 minutes on a motorway and two hours elsewhere, and the monthly report is checked against it.

## Winter and seasonal preparation

Every vehicle receives a winter check at the safety inspection falling in October: antifreeze strength, battery condition and charging output, heater and demister performance, wiper blades, screen wash concentration, tyre condition with an eye to the coming season, and the cab's winter kit (shovel, blanket, torch, high-visibility jacket). Trailers have their brake chambers and air dryers checked for moisture, which is the commonest cause of frozen brakes in the yard on a January morning. Reefer units are checked for their heating cycle, which is used more than the cooling cycle in winter for chilled goods. The spring inspection in April reverses the emphasis: air-conditioning performance, coolant system pressure test, and a check of the reefer condenser coils for the winter's road salt.

## Driver reporting and the defect app

The defect app is the single record of a vehicle's condition between workshop visits. Drivers report a defect in the app at the moment they find it, with a photograph, whether the vehicle is in the yard, on a customer's site or at the roadside; the transport office sees every open defect on the fleet screen and the workshop controller triages safety-critical items within fifteen minutes during workshop hours. Out of hours, a safety-critical defect goes to the on-call technician and the transport manager. A driver who continues a journey with an open safety-critical defect, or who fails to report a defect that a technician finds later, is dealt with under the driver handbook.

The app also carries the vehicle's current status — in service, in workshop, VOR, awaiting parts — which is what the planning system reads to decide whether a vehicle can be allocated. A vehicle cannot be allocated while any safety-critical defect is open, and the planning system will not override that status.

## Parts and consumables

The workshop holds a stock of fast-moving parts — filters, brake pads and discs, bulbs, wiper blades, mirror glass, air-line couplings, curtain buckles and straps, mudguards, marker lights — sized to a fortnight's consumption, and orders anything else against a defect on the day it is raised. Parts are bought from the manufacturer's network for anything within the warranty period and from the approved aftermarket suppliers thereafter; safety-critical items — braking, steering, suspension, wheels and tyres — are original or original-equivalent regardless of vehicle age. Every part fitted is recorded against the defect it closed, which is what allows the recurring-defect review to see a part that keeps failing.

## Roadside encounters

Any roadside stop by DVSA or the police — a prohibition, a fixed penalty, a defect notice, or a clean encounter — is reported to the transport manager by the driver before the journey continues, and the fleet engineer is told the same day. A prohibition notice, immediate or delayed, is treated as an immediate-danger event: the vehicle is recovered or repaired at the roadside, the defect is traced back to the last inspection and walk-around, and the transport manager reviews the findings with the driver and the technician who last inspected the vehicle. The Operator Compliance Risk Score is checked monthly; the fleet has been green for the last 22 months and the transport manager's objective is to keep it there.

## Records

The vehicle file, kept electronically per vehicle in the fleet system, holds: the registration document, the operator licence disc record, the insurance schedule reference, the MOT certificates, every safety inspection sheet and brake test printout for fifteen months (the system keeps them for the life of the vehicle), the tachograph calibration certificates, the tail-lift LOLER reports, the reefer service and calibration certificates, the wheel security log, the defect history and the downtime record. The traffic commissioner expects the undertakings to be evidenced from these records without notice, and the transport manager runs a mock DVSA audit on two vehicles a month to check that they are complete.

## Workshop

The Wakefield workshop runs two shifts, 06:00 to 22:00, with five technicians, an apprentice and a workshop controller, and holds an ATF lane for MOT presentation. Technicians hold the IRTEC inspection qualification and attend the manufacturer's training on each new model within six months of delivery. The workshop is audited annually by the group's compliance auditor and the report goes to the transport manager and the operations director.`,
  },
  {
    key: 'returns-policy',
    title: 'Returns policy',
    createdDaysAgo: 0,
    pending: true,
    text: `Returns policy

Customers may return unused goods in their original packaging within 30 days of delivery for a full credit, less the outbound freight where the return is not the result of our error. Damaged or short deliveries must be noted on the POD at the time of delivery and reported to customer service within 48 hours with photographs.

Returns are collected by our own fleet or a nominated carrier once customer service has issued a returns authorisation number; goods arriving without a number are held for identification and may be refused. Credits are raised within five working days of the goods being checked in at the returns bay.`,
  },
]

// ---- Conversations ------------------------------------------------------------------------------

interface DemoConversation {
  key: string
  title: string
  provider: AiProvider
  model: string
  startedDaysAgo: number
  turns: Array<{ role: 'user' | 'assistant'; content: string; usage?: TokenUsage }>
}

const DEMO_CONVERSATIONS: DemoConversation[] = [
  {
    key: 'rotterdam-lane',
    title: 'Late deliveries on the Rotterdam lane',
    provider: 'workers_ai',
    model: WORKERS_AI_CHAT_MODEL,
    startedDaysAgo: 3,
    turns: [
      {
        role: 'user',
        content:
          'We had six late deliveries on the Felixstowe–Rotterdam lane last week, all with the same carrier. What should I look at before I call them?',
      },
      {
        role: 'assistant',
        content:
          'Before the call, separate the causes so the conversation is about facts:\n\n1. **Tender-to-pickup gap** — were the loads tendered with the agreed lead time, or late on our side?\n2. **Sailing bookings** — did the loads miss a sailing because the goods movement reference or MRN arrived after check-in cut-off? That is a paperwork failure, not a carrier one.\n3. **Port dwell** — compare the port gate-in and gate-out times from the tracking feed; a customs hold shows up as dwell at Rotterdam.\n4. **Final-mile** — if the trailer cleared the port on time, the delay is the carrier’s own planning.\n\nPull the six loads’ event timelines from the TMS and mark which stage the delay sits in. If four or more are in stage 4, it is a carrier performance conversation; if they are in stage 2, it is ours.',
        usage: { inputTokens: 412, outputTokens: 221 },
      },
      {
        role: 'user',
        content: 'Four were port dwell of over 20 hours. Is that a customs problem or the carrier?',
      },
      {
        role: 'assistant',
        content:
          'Twenty-plus hours of dwell at Rotterdam almost always means the import declaration was not lodged before arrival, so the trailer waited for clearance rather than for a driver. That is usually on the importer’s broker, not the carrier — unless these were DDP orders, in which case our broker lodges the import and the delay is ours.\n\nCheck the Incoterm on the four sales orders. For DAP orders, raise it with the customers’ brokers; for DDP, check the customs incident log for the same dates. Either way, ask the carrier for the port gate timestamps so you can show the customer where the time went.',
        usage: { inputTokens: 701, outputTokens: 168 },
      },
    ],
  },
  {
    key: 'carrier-scorecard',
    title: 'Drafting a carrier scorecard',
    provider: 'anthropic',
    model: CLAUDE_MODEL,
    startedDaysAgo: 1,
    turns: [
      {
        role: 'user',
        content:
          'Draft a monthly carrier scorecard we can share with our top ten carriers. Keep it to five measures.',
      },
      {
        role: 'assistant',
        content:
          '**Carrier scorecard — monthly**\n\n| Measure | Definition | Target | Weight |\n|---|---|---|---|\n| On-time pickup | Loads collected within the booked window | ≥ 95% | 20% |\n| On-time delivery | Loads delivered within the customer’s window | ≥ 96% | 35% |\n| POD within 24 h | Signed POD uploaded to the portal within 24 hours of delivery | ≥ 98% | 15% |\n| Claims ratio | Claims raised ÷ loads moved | ≤ 0.5% | 20% |\n| Tender acceptance | Tenders accepted ÷ tenders offered | ≥ 90% | 10% |\n\nScore each measure 0–100 against its target, weight them, and band the total: **Preferred** (≥ 90), **Approved** (75–89), **Under review** (< 75). A carrier under review for two consecutive months is paused from new lanes.',
        usage: { inputTokens: 388, outputTokens: 296, cacheReadTokens: 0, cacheWriteTokens: 312 },
      },
      { role: 'user', content: 'Add a note on how we handle disputes over the numbers.' },
      {
        role: 'assistant',
        content:
          '**Disputes.** Scorecards are issued on the fifth working day of the month with the load-level data behind every measure. A carrier has ten working days to dispute individual loads through the portal, citing the event timestamps they hold. The carrier manager rules on each dispute within five working days; agreed corrections are reflected in a re-issued scorecard, and the ruling is final for that month. Disputes are not accepted for loads where the carrier did not provide tracking.',
        usage: { inputTokens: 724, outputTokens: 118, cacheReadTokens: 312, cacheWriteTokens: 0 },
      },
      { role: 'user', content: 'Thanks — that is the version we will circulate.' },
    ],
  },
]

// ---- Helpers -------------------------------------------------------------------------------------

type DemoUser = typeof users.$inferSelect

async function upsertDemoUser(
  db: Database,
  input: { email: string; name: string; lastLoginAt: Date }
): Promise<DemoUser> {
  const existing = await db.query.users.findFirst({
    where: sql`lower(${users.email}) = ${input.email.toLowerCase()}`,
  })
  if (existing) return existing
  const [created] = await db
    .insert(users)
    .values({
      email: input.email,
      name: input.name,
      emailVerifiedAt: input.lastLoginAt,
      lastLoginAt: input.lastLoginAt,
    })
    .returning()
  if (!created) throw new Error(`seed: could not create ${input.email}`)
  return created
}

/** A preview of tool result text the way `summariseToolResult` records it (600 chars). */
function preview(text: string): { text: string; truncated?: true } {
  return text.length > 600 ? { text: `${text.slice(0, 600)}…`, truncated: true } : { text }
}

async function seedDemo(
  db: Database,
  tenant: typeof tenants.$inferSelect,
  owner: DemoUser,
  log: (s: string) => void
) {
  log('')
  log('Demo data (--demo)…')
  const tenantId = tenant.id

  // -- Names: the seeded people and the organisation get real-looking ones -----------------------
  if (TENANCY_MODE === 'multi' && tenant.name !== DEMO_TENANT_NAME) {
    await db.update(tenants).set({ name: DEMO_TENANT_NAME }).where(eq(tenants.id, tenantId))
  }
  await db
    .update(tenants)
    .set({ seedDataCreated: true })
    .where(and(eq(tenants.id, tenantId), eq(tenants.seedDataCreated, false)))
  for (const seedUser of SEED_USERS) {
    await db
      .update(users)
      .set({ name: DEMO_SEED_USER_NAMES[seedUser.email], lastLoginAt: ago(0, 2) })
      .where(and(sql`lower(${users.email}) = ${seedUser.email}`, isNull(users.lastLoginAt)))
    await db
      .update(users)
      .set({ name: DEMO_SEED_USER_NAMES[seedUser.email] })
      .where(and(sql`lower(${users.email}) = ${seedUser.email}`, eq(users.name, seedUser.name)))
  }
  const admin = await upsertUser(db, SEED_USERS[1])
  const member = await upsertUser(db, SEED_USERS[2])
  // The organisation and its founding members predate the two weeks of activity below.
  const founded = ago(14, 2)
  await db
    .update(tenants)
    .set({ createdAt: founded })
    .where(and(eq(tenants.id, tenantId), gt(tenants.createdAt, founded)))
  for (const [i, u] of [owner, admin, member].entries()) {
    const joinedAt = new Date(founded.getTime() + i * 25 * MINUTE)
    await db
      .update(tenantUsers)
      .set({ joinedAt })
      .where(
        and(
          eq(tenantUsers.tenantId, tenantId),
          eq(tenantUsers.userId, u.id),
          gt(tenantUsers.joinedAt, joinedAt)
        )
      )
  }

  // -- Members -----------------------------------------------------------------------------------
  const demoMembers: Array<{ user: DemoUser; role: 'admin' | 'member'; joinedAt: Date }> = []
  for (const m of DEMO_MEMBERS) {
    const joinedAt = ago(m.joined, 3)
    const user = await upsertDemoUser(db, { email: m.email, name: m.name, lastLoginAt: ago(0, 5) })
    await db
      .insert(tenantUsers)
      .values({ tenantId, userId: user.id, role: m.role, joinedAt, invitedByUserId: owner.id })
      .onConflictDoNothing()
    demoMembers.push({ user, role: m.role, joinedAt })
  }
  log(`  members ${DEMO_MEMBERS.length} more on @acme.example`)

  // -- Sibling tenants (multi-tenant only) -------------------------------------------------------
  const siblings: Array<typeof tenants.$inferSelect> = []
  if (TENANCY_MODE === 'multi') {
    for (const t of DEMO_TENANTS) {
      const tenantOwner = await upsertDemoUser(db, { ...t.owner, lastLoginAt: ago(1, 4) })
      const existing = await db.query.tenants.findFirst({ where: eq(tenants.slug, t.slug) })
      const row =
        existing ??
        (await createTenantForUser(db, {
          name: t.name,
          slug: t.slug,
          userId: tenantOwner.id,
          role: 'owner',
        }))
      await db
        .update(tenants)
        .set({ seedDataCreated: true })
        .where(and(eq(tenants.id, row.id), eq(tenants.seedDataCreated, false)))
      siblings.push(row)
      log(`  tenant  ${row.name} (${row.slug}) — owner ${t.owner.email}`)
    }
  }

  // -- Knowledge base ----------------------------------------------------------------------------
  const docIds = new Map<string, string>()
  const docChunks = new Map<string, ReturnType<typeof chunkText>>()
  let chunkRows = 0
  for (const doc of DEMO_DOCUMENTS) {
    const id = demoId(`document:${doc.key}`)
    docIds.set(doc.key, id)
    const pieces = doc.pending ? [] : chunkText(doc.text)
    docChunks.set(doc.key, pieces)
    const createdAt = ago(doc.createdDaysAgo, 6)
    // A demo text that changed since it was seeded: replace the content and every chunk (ids are
    // `chunk:<key>:<seq>`, so a plain onConflictDoNothing would leave old text on the low seqs).
    const existing = await db.query.documents.findFirst({
      columns: { id: true, content: true },
      where: eq(documents.id, id),
    })
    if (existing && existing.content !== doc.text) {
      await db.delete(chunks).where(eq(chunks.documentId, id))
      await db
        .update(documents)
        .set({
          content: doc.text,
          sizeBytes: new TextEncoder().encode(doc.text).byteLength,
          chunkCount: pieces.length,
          embeddingModel: doc.pending ? null : DETERMINISTIC_EMBEDDING_MODEL,
          status: doc.pending ? 'pending' : 'indexed',
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, id))
    }
    await db
      .insert(documents)
      .values({
        id,
        tenantId,
        ownerUserId: owner.id,
        title: doc.title,
        source: 'text',
        contentType: 'text/plain',
        sizeBytes: new TextEncoder().encode(doc.text).byteLength,
        content: doc.text,
        chunkCount: pieces.length,
        embeddingModel: doc.pending ? null : DETERMINISTIC_EMBEDDING_MODEL,
        status: doc.pending ? 'pending' : 'indexed',
        createdAt,
        updatedAt: doc.pending ? ago(0, 0, 3) : createdAt,
      })
      .onConflictDoNothing()
    if (pieces.length > 0) {
      await db
        .insert(chunks)
        .values(
          pieces.map(p => ({
            id: demoId(`chunk:${doc.key}:${p.seq}`),
            documentId: id,
            tenantId,
            seq: p.seq,
            text: p.text,
            tokenCount: p.tokenCount,
            embedding: deterministicEmbedding(p.text),
            createdAt,
            updatedAt: createdAt,
          }))
        )
        .onConflictDoNothing()
      chunkRows += pieces.length
    }
  }
  log(`  docs    ${DEMO_DOCUMENTS.length} (${chunkRows} chunks, deterministic embeddings)`)

  // -- Conversations -----------------------------------------------------------------------------
  let messageRows = 0
  for (const conv of DEMO_CONVERSATIONS) {
    const conversationId = demoId(`conversation:${conv.key}`)
    const startedAt = ago(conv.startedDaysAgo, 5)
    const rows = conv.turns.map((turn, i) => ({
      id: demoId(`message:${conv.key}:${i}`),
      conversationId,
      tenantId,
      role: turn.role,
      content: turn.content,
      usage: turn.usage ? tokenUsageSchema.parse(turn.usage) : null,
      createdAt: new Date(
        startedAt.getTime() + i * 40 * 1000 + (turn.role === 'assistant' ? 6000 : 0)
      ),
    }))
    const lastMessageAt = rows[rows.length - 1]?.createdAt ?? startedAt
    await db
      .insert(conversations)
      .values({
        id: conversationId,
        tenantId,
        userId: owner.id,
        title: conv.title,
        provider: conv.provider,
        model: conv.model,
        lastMessageAt,
        createdAt: startedAt,
        updatedAt: lastMessageAt,
      })
      .onConflictDoNothing()
    await db.insert(messages).values(rows).onConflictDoNothing()
    messageRows += rows.length
  }
  log(`  chats   ${DEMO_CONVERSATIONS.length} conversations (${messageRows} messages)`)

  // -- Agent runs --------------------------------------------------------------------------------
  const audit = DEMO_DOCUMENTS.find(d => d.key === 'warehouse-safety-audit')
  const customs = DEMO_DOCUMENTS.find(d => d.key === 'customs-eu')
  if (!audit || !customs) throw new Error('seed: demo documents missing')
  const customsId = docIds.get('customs-eu') as string
  const customsChunks = docChunks.get('customs-eu') ?? []
  const customsHit = customsChunks.find(c => c.text.includes('Who signs what')) ?? customsChunks[0]
  if (!customsHit) throw new Error('seed: customs document produced no chunks')
  // The citation must point where retrieval would: `position(chunk in content) - 1`.
  const customsHitOffset = customs.text.indexOf(customsHit.text)
  if (customsHitOffset < 0)
    throw new Error('seed: customs passage is not locatable in its document')
  if (audit.text.length > SUMMARIZE_TEXT_MAX_CHARS) {
    throw new Error(
      `seed: the audit document (${audit.text.length} chars) exceeds SUMMARIZE_TEXT_MAX_CHARS — it is the summarize-text run's input`
    )
  }

  type RunEvent = { type: string; data: unknown; offsetSeconds: number }
  const event = (type: string, data: unknown, offsetSeconds: number): RunEvent => ({
    type,
    data: type === 'step' ? agentStepEventDataSchema.parse(data) : data,
    offsetSeconds,
  })

  const summaryInput = summarizeTextInputSchema.parse({
    text: audit.text,
    style: 'bullets',
    index: false,
  })
  const summaryOutput = summarizeTextOutputSchema.parse({
    summary:
      'The Q3 audit of the Leeds distribution centre rated the site amber: two major findings (racking damage in aisles 7–11 and an unprotected pedestrian crossing at the loading doors) and five minor ones, with no immediate-danger findings. Both major actions have owners and dates, and the regional lead will re-audit them within 30 days of closure.',
    keyPoints: [
      'Racking: 14 upright protectors missing and 3 uprights dented beyond the SEMA amber threshold; bays tagged out, weekly inspections to be reinstated by 15 August.',
      'Pedestrian segregation: the canteen walkway crosses the forklift route without a barrier; two near-misses in June; gated crossing due 30 September.',
      'Minor findings: forklift pre-use checks at 71%, two expired extinguishers, an empty eyewash station, three untrained starters and an incomplete spill kit.',
      'Ventilation, fire alarm testing and high-visibility compliance were all satisfactory.',
    ],
  })
  const summaryRun = {
    id: demoId('run:summarize-text'),
    agentKey: 'summarize-text' as const,
    input: summaryInput,
    output: summaryOutput,
    startedAt: ago(4, 3, 12),
    durationSeconds: 14,
    events: [
      event('status', { status: 'running', attempt: 1 }, 0),
      event('step', { key: 'precheck', label: 'Checking the input', status: 'running' }, 0.2),
      event(
        'step',
        {
          key: 'precheck',
          label: 'Checking the input',
          status: 'done',
          detail: `${audit.text.trim().length} characters`,
        },
        0.3
      ),
      event('step', { key: 'summarize', label: 'Summarising', status: 'running' }, 0.4),
      event('tool.start', { name: 'submit_summary', style: 'bullets' }, 0.5),
      event(
        'tool.end',
        { name: 'submit_summary', keyPoints: summaryOutput.keyPoints.length },
        12.8
      ),
      event('text', { text: summaryOutput.summary }, 12.9),
      event(
        'step',
        {
          key: 'summarize',
          label: 'Summarising',
          status: 'done',
          detail: `${summaryOutput.keyPoints.length} key points`,
        },
        13
      ),
      event('status', { status: 'succeeded' }, 13.5),
    ],
  }

  const researchInput = researchTopicInputSchema.parse({
    topic: 'What documents do we need for an EU shipment from the UK, and who signs each one?',
  })
  const researchOutput = researchTopicOutputSchema.parse({
    answer: `Every EU shipment from a UK site needs five documents, and two more depending on the goods (*Customs paperwork: EU shipments*):

1. **Commercial invoice** — prepared by the customer service desk from the sales order, with both parties’ EORI numbers, the Incoterm, commodity codes and origin per line; signed by the **customer service lead**.
2. **Packing list** — prepared by the warehouse at picking, totals matching the invoice exactly; signed by the **warehouse shift supervisor**.
3. **Export declaration** — submitted by the customs broker on CDS before departure; the **export coordinator** requests it and confirms the MRN is back before collection.
4. **CMR consignment note** — four copies printed from the TMS; signed by the **driver** on collection and by the **consignee** on delivery (the returned copy is the proof of export).
5. **Import declaration** — lodged by the importer’s broker, or by our broker via the EU fiscal representative when we sell DDP.

Where goods qualify for preferential duty, the invoice carries the **statement on origin**; the product compliance analyst approves the qualifying SKU list and customer service applies it. Food and animal-origin products additionally need an **export health certificate**, and dangerous goods a **dangerous goods note** signed only by the trained DG signatory.

Before release, the export coordinator runs the pre-departure checklist — a vehicle failing any check is held rather than released.`,
    citations: [{ documentId: customsId, title: customs.title }],
    turns: 3,
  })
  const searchQuery = 'EU shipment documents who signs'
  const searchResult = {
    query: searchQuery,
    documents: [
      {
        documentId: customsId,
        title: customs.title,
        totalPassages: customsChunks.length,
        matchingPassages: 1,
        passages: [
          {
            rank: 1,
            passage: customsHit.seq + 1,
            charOffset: customsHitOffset,
            score: 0.0328,
            ...preview(customsHit.text),
          },
        ],
      },
    ],
    passagesReturned: 1,
    note: 'These are the closest passages to the query, not a relevance filter — read them and ignore any that do not answer the question. If none do, search again with different wording before concluding the knowledge base does not cover it.',
  }
  const documentResult = {
    documentId: customsId,
    title: customs.title,
    contentType: 'text/plain',
    totalChars: customs.text.length,
    offset: 0,
    returnedChars: customs.text.length,
    hasMore: false,
    nextOffset: null,
    ...preview(customs.text),
  }
  const researchRun = {
    id: demoId('run:research-topic'),
    agentKey: 'research-topic' as const,
    input: researchInput,
    output: researchOutput,
    startedAt: ago(2, 6, 41),
    durationSeconds: 58,
    events: [
      event('status', { status: 'running', attempt: 1 }, 0),
      event(
        'step',
        { key: 'research', label: 'Searching the knowledge base', status: 'running' },
        0.3
      ),
      event('tool.start', { name: 'search_knowledge', input: { query: searchQuery } }, 9.1),
      event('tool.end', { name: 'search_knowledge', isError: false, result: searchResult }, 10.4),
      event(
        'step',
        {
          key: 'research',
          label: 'Searching the knowledge base',
          status: 'running',
          detail: 'turn 1: search_knowledge',
        },
        10.5
      ),
      event(
        'tool.start',
        { name: 'get_document', input: { documentId: customsId, offset: 0 } },
        18.7
      ),
      event('tool.end', { name: 'get_document', isError: false, result: documentResult }, 18.9),
      event(
        'step',
        {
          key: 'research',
          label: 'Searching the knowledge base',
          status: 'running',
          detail: 'turn 2: get_document',
        },
        19
      ),
      event(
        'step',
        {
          key: 'research',
          label: 'Searching the knowledge base',
          status: 'done',
          detail: '3 turns, 1 document consulted',
        },
        55.2
      ),
      event(
        'step',
        { key: 'answer', label: 'Writing the answer', status: 'done', detail: '1 citation' },
        55.3
      ),
      event('status', { status: 'succeeded' }, 57.4),
    ],
  }

  let eventRows = 0
  for (const run of [summaryRun, researchRun]) {
    const finishedAt = new Date(run.startedAt.getTime() + run.durationSeconds * 1000)
    const createdAt = new Date(run.startedAt.getTime() - 1500)
    await db
      .insert(agentRuns)
      .values({
        id: run.id,
        tenantId,
        agentKey: run.agentKey,
        status: 'succeeded',
        input: run.input,
        output: run.output,
        error: null,
        requestedByUserId: owner.id,
        instanceId: run.id,
        attempt: 1,
        startedAt: run.startedAt,
        finishedAt,
        createdAt,
        updatedAt: finishedAt,
      })
      // The input/output and the tool results are derived from the demo documents, so a text
      // change re-derives them on the next run (ids and timestamps stay as they were).
      .onConflictDoUpdate({
        target: agentRuns.id,
        set: { input: run.input, output: run.output },
      })
    for (const [i, e] of run.events.entries()) {
      await db
        .insert(agentRunEvents)
        .values({
          id: demoId(`run-event:${run.agentKey}:${i + 1}`),
          runId: run.id,
          tenantId,
          seq: i + 1,
          type: e.type as (typeof agentRunEvents.$inferInsert)['type'],
          data: e.data,
          at: new Date(run.startedAt.getTime() + e.offsetSeconds * 1000),
        })
        .onConflictDoUpdate({ target: agentRunEvents.id, set: { data: e.data } })
    }
    eventRows += run.events.length
  }
  log(`  runs    2 agent runs (${eventRows} events)`)

  // -- Dashboards (so the activity below can point at a real page) -------------------------------
  await ensureDefaultDashboards(db, tenantId, owner.id)
  for (const sibling of siblings) await ensureDefaultDashboards(db, sibling.id, null)
  const overview = await db.query.analyticsPages.findFirst({
    where: and(eq(analyticsPages.tenantId, tenantId), eq(analyticsPages.slug, 'tenant-overview')),
  })

  // -- Activity: two weeks of it, by the people above ---------------------------------------------
  const seedKey = await db.query.apiKeys.findFirst({
    where: and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.name, SEED_KEY_NAME)),
  })
  type Activity = {
    key: string
    userId: string | null
    type: string
    subjectType: string
    subjectId: string
    metadata: Record<string, unknown>
    at: Date
  }
  const activity: Activity[] = []
  activity.push({
    key: 'tenant-renamed',
    userId: owner.id,
    type: 'tenant.updated',
    subjectType: 'Tenant',
    subjectId: tenantId,
    metadata: { name: DEMO_TENANT_NAME },
    at: ago(13, 9),
  })
  if (seedKey) {
    activity.push({
      key: 'seed-key',
      userId: owner.id,
      type: 'api_key.created',
      subjectType: 'ApiKey',
      subjectId: seedKey.id,
      metadata: { name: seedKey.name, scopes: seedKey.scopes },
      at: ago(13, 8),
    })
  }
  // Marcus (admin) and Sofia invite; each invitation is accepted the next day.
  demoMembers.forEach((m, i) => {
    const inviter = i < 3 ? admin : (demoMembers[0]?.user ?? owner)
    const invitationId = demoId(`invitation:${m.user.email}`)
    activity.push({
      key: `invited:${m.user.email}`,
      userId: inviter.id,
      type: 'member.invited',
      subjectType: 'Invitation',
      subjectId: invitationId,
      metadata: { email: m.user.email, role: m.role },
      at: new Date(m.joinedAt.getTime() - DAY + 2 * HOUR),
    })
    activity.push({
      key: `joined:${m.user.email}`,
      userId: m.user.id,
      type: 'member.joined',
      subjectType: 'TenantMember',
      subjectId: m.user.id,
      metadata: { via: 'invitation', invitationId, role: 'member' },
      at: m.joinedAt,
    })
  })
  const sofia = demoMembers[0]
  if (sofia) {
    activity.push({
      key: 'sofia-promoted',
      userId: owner.id,
      type: 'member.role_changed',
      subjectType: 'TenantMember',
      subjectId: sofia.user.id,
      metadata: { from: 'member', to: 'admin' },
      at: new Date(sofia.joinedAt.getTime() + 5 * HOUR),
    })
  }
  activity.push({
    key: 'invited:pending',
    userId: owner.id,
    type: 'member.invited',
    subjectType: 'Invitation',
    subjectId: demoId(`invitation:${INVITED_EMAIL}`),
    metadata: { email: INVITED_EMAIL, role: 'member' },
    at: ago(1, 2),
  })
  activity.push({
    key: 'invitation-revoked',
    userId: admin.id,
    type: 'invitation.revoked',
    subjectType: 'Invitation',
    subjectId: demoId('invitation:temp@acme.example'),
    metadata: { email: 'temp@acme.example' },
    at: ago(6, 1),
  })
  if (overview) {
    activity.push({
      key: 'dashboard-created',
      userId: owner.id,
      type: 'dashboard.created',
      subjectType: 'Dashboard',
      subjectId: overview.id,
      metadata: { name: overview.name },
      at: ago(12, 4),
    })
  }
  for (const doc of DEMO_DOCUMENTS) {
    const pieces = docChunks.get(doc.key) ?? []
    activity.push({
      key: `document:${doc.key}`,
      userId: owner.id,
      type: 'document.ingested',
      subjectType: 'Document',
      subjectId: docIds.get(doc.key) as string,
      metadata: doc.pending
        ? { mode: 'queued', status: 'pending', chunkCount: 0 }
        : { mode: 'inline', status: 'indexed', chunkCount: pieces.length },
      at: ago(doc.createdDaysAgo, 6),
    })
  }
  for (const conv of DEMO_CONVERSATIONS) {
    activity.push({
      key: `conversation:${conv.key}`,
      userId: owner.id,
      type: 'conversation.created',
      subjectType: 'Conversation',
      subjectId: demoId(`conversation:${conv.key}`),
      metadata: { provider: conv.provider, model: conv.model },
      at: ago(conv.startedDaysAgo, 5),
    })
  }
  for (const run of [summaryRun, researchRun]) {
    activity.push({
      key: `run:${run.agentKey}`,
      userId: owner.id,
      type: 'agent_run.requested',
      subjectType: 'AgentRun',
      subjectId: run.id,
      metadata: { agentKey: run.agentKey },
      at: new Date(run.startedAt.getTime() - 1500),
    })
  }
  const uploaders = [member, ...demoMembers.slice(1, 3).map(m => m.user)]
  uploaders.forEach((u, i) => {
    activity.push({
      key: `avatar:${u.email}`,
      userId: u.id,
      type: 'file.uploaded',
      subjectType: 'File',
      subjectId: demoId(`file:avatar:${u.email}`),
      metadata: {
        scope: 'avatars',
        contentType: 'image/png',
        sizeBytes: 48_000 + i * 3_100,
        filename: 'avatar.png',
      },
      at: ago(9 - i * 3, 7 + i),
    })
  })
  await db
    .insert(activityEvents)
    .values(
      activity.map(a => ({
        id: demoId(`activity:${a.key}`),
        tenantId,
        userId: a.userId,
        type: a.type,
        subjectType: a.subjectType,
        subjectId: a.subjectId,
        metadata: a.metadata,
        createdAt: a.at,
      }))
    )
    .onConflictDoNothing()
  log(`  events  ${activity.length} activity events over the last 14 days`)

  // -- AI usage ledger ---------------------------------------------------------------------------
  const LLAMA = { provider: 'workers_ai' as const, model: WORKERS_AI_CHAT_MODEL }
  const CLAUDE = { provider: 'anthropic' as const, model: CLAUDE_MODEL }
  const usageRows: Array<{
    feature: string
    provider: AiProvider
    model: string
    usage: TokenUsage
    daysAgo: number
    hour: number
  }> = [
    {
      feature: 'chat',
      ...LLAMA,
      usage: { inputTokens: 1120, outputTokens: 240 },
      daysAgo: 13,
      hour: 10,
    },
    {
      feature: 'chat',
      ...LLAMA,
      usage: { inputTokens: 1860, outputTokens: 310 },
      daysAgo: 12,
      hour: 15,
    },
    {
      feature: 'chat',
      ...CLAUDE,
      usage: { inputTokens: 940, outputTokens: 402, cacheWriteTokens: 512 },
      daysAgo: 11,
      hour: 9,
    },
    {
      feature: 'agent:summarize-text',
      ...LLAMA,
      usage: { inputTokens: 1710, outputTokens: 360 },
      daysAgo: 10,
      hour: 11,
    },
    {
      feature: 'chat',
      ...CLAUDE,
      usage: { inputTokens: 1530, outputTokens: 288, cacheReadTokens: 512 },
      daysAgo: 9,
      hour: 16,
    },
    {
      feature: 'agent:research-topic',
      ...LLAMA,
      usage: { inputTokens: 6420, outputTokens: 910 },
      daysAgo: 8,
      hour: 14,
    },
    {
      feature: 'chat',
      ...LLAMA,
      usage: { inputTokens: 2210, outputTokens: 355 },
      daysAgo: 7,
      hour: 10,
    },
    {
      feature: 'agent:summarize-text',
      ...CLAUDE,
      usage: { inputTokens: 1880, outputTokens: 331 },
      daysAgo: 6,
      hour: 13,
    },
    {
      feature: 'chat',
      ...CLAUDE,
      usage: { inputTokens: 2740, outputTokens: 512, cacheReadTokens: 1024, cacheWriteTokens: 256 },
      daysAgo: 5,
      hour: 17,
    },
    {
      feature: 'agent:research-topic',
      ...CLAUDE,
      usage: { inputTokens: 7950, outputTokens: 1180, cacheReadTokens: 2048 },
      daysAgo: 4,
      hour: 9,
    },
    {
      feature: 'agent:summarize-text',
      ...LLAMA,
      usage: { inputTokens: 1745, outputTokens: 342 },
      daysAgo: 4,
      hour: 3,
    },
    {
      feature: 'chat',
      ...LLAMA,
      usage: { inputTokens: 412, outputTokens: 221 },
      daysAgo: 3,
      hour: 5,
    },
    {
      feature: 'chat',
      ...LLAMA,
      usage: { inputTokens: 701, outputTokens: 168 },
      daysAgo: 3,
      hour: 5,
    },
    {
      feature: 'agent:research-topic',
      ...LLAMA,
      usage: { inputTokens: 5880, outputTokens: 864 },
      daysAgo: 2,
      hour: 6,
    },
    {
      feature: 'chat',
      ...CLAUDE,
      usage: { inputTokens: 388, outputTokens: 296, cacheWriteTokens: 312 },
      daysAgo: 1,
      hour: 5,
    },
    {
      feature: 'chat',
      ...CLAUDE,
      usage: { inputTokens: 724, outputTokens: 118, cacheReadTokens: 312 },
      daysAgo: 1,
      hour: 5,
    },
  ]
  let costTotal = 0
  await db
    .insert(aiUsage)
    .values(
      usageRows.map((u, i) => {
        // The same expression `recordUsage` uses; it takes no id, so the row is written here directly.
        const cost = estimateCostMicrocents(u.provider, u.model, u.usage)
        costTotal += cost ?? 0
        return {
          id: demoId(`usage:${i}`),
          tenantId,
          userId: owner.id,
          feature: u.feature,
          provider: u.provider,
          model: u.model,
          inputTokens: u.usage.inputTokens,
          outputTokens: u.usage.outputTokens,
          cacheReadTokens: u.usage.cacheReadTokens ?? 0,
          cacheWriteTokens: u.usage.cacheWriteTokens ?? 0,
          costMicrocents: cost,
          at: ago(u.daysAgo, u.hour, i),
        }
      })
    )
    .onConflictDoNothing()
  log(
    `  usage   ${usageRows.length} ai_usage rows (≈ $${(costTotal / 100_000_000).toFixed(4)} estimated)`
  )

  // -- Fact tables -------------------------------------------------------------------------------
  const refreshed = await refreshAllFactTables(db)
  for (const r of refreshed.results) {
    log(`  facts   ${r.table} tenants=${r.tenants} rows=${r.rows}`)
    for (const e of r.errors) log(`    FAILED tenant ${e.tenantId}: ${e.error}`)
  }

  // -- Summary: what the database now holds for this tenant -------------------------------------
  const countOf = async (table: any, where: any) => {
    const [row] = await db.select({ n: count() }).from(table).where(where)
    return Number(row?.n ?? 0)
  }
  const inTenant = (table: { tenantId: any }) => eq(table.tenantId, tenantId)
  const [tenantCount] = await db.select({ n: count() }).from(tenants)
  const summary = {
    tenants: Number(tenantCount?.n ?? 0),
    members: await countOf(tenantUsers, inTenant(tenantUsers)),
    pendingInvites: await countOf(
      teamInvitations,
      and(
        inTenant(teamInvitations),
        isNull(teamInvitations.acceptedAt),
        isNull(teamInvitations.revokedAt)
      )
    ),
    activity: await countOf(activityEvents, inTenant(activityEvents)),
    conversations: await countOf(conversations, inTenant(conversations)),
    messages: await countOf(messages, inTenant(messages)),
    documents: await countOf(documents, inTenant(documents)),
    indexed: await countOf(documents, and(inTenant(documents), eq(documents.status, 'indexed'))),
    chunks: await countOf(chunks, inTenant(chunks)),
    runs: await countOf(agentRuns, inTenant(agentRuns)),
    runEvents: await countOf(agentRunEvents, inTenant(agentRunEvents)),
    usage: await countOf(aiUsage, inTenant(aiUsage)),
    facts: await countOf(tenantActivityDailyFacts, inTenant(tenantActivityDailyFacts)),
  }
  log('')
  log(`Workspace ${tenant.slug} now holds (all rows, demo and otherwise):`)
  log(`  tenants        ${summary.tenants} in total`)
  log(`  members        ${summary.members} (+${summary.pendingInvites} pending invitation)`)
  log(`  activity       ${summary.activity} events`)
  log(`  conversations  ${summary.conversations} (${summary.messages} messages)`)
  log(
    `  documents      ${summary.documents} (${summary.indexed} indexed, ${summary.documents - summary.indexed} pending; ${summary.chunks} chunks)`
  )
  log(`  agent runs     ${summary.runs} (${summary.runEvents} events)`)
  log(`  ai usage       ${summary.usage} rows`)
  log(`  fact rows      ${summary.facts} tenant_activity_daily_facts`)
}

main()
  .catch(err => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => closeAllDatabases())
