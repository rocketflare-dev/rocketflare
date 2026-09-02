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
 * (timestamps are therefore frozen at the first demo run). Chunk vectors come from
 * `deterministicEmbedding` (no embeddings provider exists under `tsx`): against a query embedded by
 * the real provider the dense half of the hybrid search is noise, so it is the lexical half
 * (`websearch_to_tsquery`) that finds a seeded passage from `/search` or `search_knowledge`.
 */
import { createHash } from 'node:crypto'
import {
  agentStepEventDataSchema,
  researchTopicInputSchema,
  researchTopicOutputSchema,
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
    text: `Carrier onboarding checklist

Every new carrier goes through the same six gates before the first load is tendered. The carrier manager owns the file; nothing moves to the TMS until the last gate is signed off in the onboarding tracker.

1. Legal entity and authority. Collect the company registration number, VAT number and the operator licence (O-licence in the UK, Community licence for EU cross-border work). Check the licence status on the regulator's public register and record the expiry date — the tracker raises a task 60 days before it lapses.

2. Insurance. Goods-in-transit cover of at least £100,000 per vehicle, public liability of £5m and employer's liability of £10m. We accept a broker's letter for the first 30 days but the policy schedule must be on file before the second invoice is paid. CMR insurance is mandatory for any international lane.

3. Compliance questionnaire. Driver vetting policy, tachograph and working-time procedures, vehicle maintenance intervals, and a named transport manager with a CPC. A carrier without a written drug-and-alcohol policy is not onboarded, no exceptions.

4. Commercial terms. Rate card per lane with fuel surcharge mechanism, accessorial schedule (waiting time after two hours free, redelivery, tail-lift), payment terms (45 days end of month) and the self-billing agreement. Rates are loaded into the TMS by the pricing analyst, never by the carrier manager.

5. Systems. Create the carrier in the TMS, issue portal logins to the carrier's planner and accounts contact, and confirm they can accept a tender, upload a POD and see remittance advice. Telematics integration is optional for domestic work and required for temperature-controlled lanes.

6. Trial period. The first ten loads are monitored daily: on-time pickup, on-time delivery, POD within 24 hours and claims. A carrier scoring under 90% on-time delivery in the trial is paused and reviewed with the head of operations before any further tenders.

Re-verification. Insurance and licence documents are re-collected annually; the questionnaire is refreshed every two years or after any reportable incident.`,
  },
  {
    key: 'warehouse-safety-audit',
    title: 'Q3 warehouse safety audit',
    createdDaysAgo: 9,
    text: `Q3 warehouse safety audit — Leeds distribution centre

Audit date: 18 July. Auditor: regional H&S lead with the site manager and the union safety representative. Scope: racking, mechanical handling equipment, pedestrian segregation, fire systems, first aid and training records. Overall rating: amber — two major findings, five minor findings, no immediate-danger findings.

Major finding 1 — racking damage. Fourteen upright protectors were missing or displaced in aisles 7 to 11, and three uprights showed dents beyond the SEMA amber threshold. The bays were offloaded and tagged out during the audit. Action: replace the damaged uprights, refit protectors, and reinstate the weekly racking inspection by the shift supervisor, which had lapsed since April. Owner: site manager. Due: 15 August.

Major finding 2 — pedestrian segregation. The marked walkway from the canteen to the goods-out office crosses the forklift route at the loading doors without a barrier or a controlled crossing. Two near-misses were reported in June. Action: install a barrier-gated crossing with mirror and warning beacon; re-route the walkway behind the marshalling area as the permanent fix. Owner: regional operations director. Due: 30 September.

Minor findings. Forklift pre-use checklists were completed for only 71% of shifts; two fire extinguishers were past their service date; the eyewash station in the battery charging area was empty; three new starters had no record of manual handling training; the spill kit at bay 4 was missing absorbent pads.

Positive observations. Charging-area ventilation was compliant, the fire alarm test log was complete, and the high-visibility policy was followed by every person observed on the floor.

Next steps. The site manager submits a closure report with photographs for each action; the regional lead re-audits the two major findings within 30 days of their due dates. The Q4 audit will add racking load notices and mezzanine edge protection to the scope.`,
  },
  {
    key: 'customs-eu',
    title: 'Customs paperwork: EU shipments',
    createdDaysAgo: 7,
    text: `Customs paperwork: EU shipments

This is the operating guide for moving goods from our UK sites to customers in the European Union. It covers which documents each shipment needs, who prepares and signs them, and the checks that stop a truck being held at the border. It does not cover excise goods or controlled products, which have their own procedure.

Documents required for every EU shipment

Commercial invoice. Prepared by the customer service desk from the sales order. It must show the seller and buyer with their EORI numbers, the Incoterm and named place, a line-by-line description with commodity codes (HS codes at eight digits for export, ten for the importer), country of origin per line, unit and total values, currency, and the invoice number that the export declaration will reference. The customer service lead signs it.

Packing list. Prepared by the warehouse at the point of picking. It lists every carton and pallet with dimensions, gross and net weight, and the marks and numbers that appear on the labels. The warehouse shift supervisor signs it, and the totals must match the invoice exactly — a mismatch is the most common reason for a query at the port.

Export declaration. Submitted through our customs broker on the Customs Declaration Service before the goods leave the site. The broker needs the invoice, the packing list and the transport details (haulier, vehicle registration, trailer number, port and sailing). The Movement Reference Number the broker returns goes on the CMR and is emailed to the haulier. The export coordinator is responsible for submitting the request to the broker and for confirming the MRN is back before the collection time.

CMR consignment note. Four copies, printed by the export coordinator from the TMS. Box 1 sender, box 2 consignee, box 3 place of delivery, box 4 place and date of taking over, box 5 attached documents (invoice number, packing list, MRN), boxes 6 to 12 the goods, and box 13 the sender's instructions including the customs office of exit. The driver signs on collection and keeps two copies; the consignee signs the delivery copy, which the haulier returns to us as the proof of export.

Import declaration. Lodged in the destination member state by the importer's broker, unless we sell Delivered Duty Paid, in which case our broker lodges it through our EU fiscal representative. Under DDP, the import VAT and duty are invoiced back to us, so the pricing team must have approved the DDP rate before the order is accepted.

Proof of origin. Where the goods qualify for preferential duty under the Trade and Cooperation Agreement, the invoice carries the statement on origin with our REX or EORI number. The product compliance analyst decides whether a product qualifies and maintains the list of qualifying SKUs; customer service must not add the statement to a product that is not on the list.

Additional documents by product type

Food and animal-origin products need an export health certificate signed by an official veterinarian and pre-notification in TRACES by the importer. Wood packaging must be ISPM 15 stamped — check every pallet. Dangerous goods need a dangerous goods note signed by the trained DG signatory, and the haulier must be ADR-approved for the class carried. Safety data sheets accompany chemicals in the language of the destination.

Who signs what

Commercial invoice: customer service lead. Packing list: warehouse shift supervisor. Export declaration request: export coordinator. CMR: the driver on collection, the consignee on delivery. Dangerous goods note: the DG signatory only. Statement on origin: the product compliance analyst approves the SKU list; customer service applies it.

Pre-departure checks

The export coordinator runs the checklist before releasing a vehicle: invoice and packing list totals agree; EORI numbers present for both parties; MRN received and written on the CMR; the driver has all four CMR copies and the invoice; the haulier has the GVMS goods movement reference for the sailing; any health certificate or dangerous goods note is in the document wallet. A vehicle that fails a check is held, not released with a promise to fix it in transit.

Common failures and what they cost

A missing MRN means the vehicle is refused at check-in and misses the sailing — typically a 24-hour delay and a re-booking fee. A packing-list mismatch triggers a physical inspection at the port of entry, which averages two days. A missing statement on origin means the customer pays full duty and raises a claim against us for the difference. Each of these is logged as a customs incident in the TMS and reviewed at the monthly operations meeting.

Record keeping

Every document is kept for six years from the end of the year of shipment, in the shipment folder in the document store, named with the sales order number. The customs broker keeps the declarations, but we keep our own copy of the MRN and the signed CMR because they are what HMRC asks for in a zero-rating audit.`,
  },
  {
    key: 'fleet-maintenance',
    title: 'Fleet maintenance schedule',
    createdDaysAgo: 5,
    text: `Fleet maintenance schedule

The owned fleet is 42 tractor units, 18 rigid trucks and 71 trailers, maintained under the operator licence undertakings. The schedule below is the minimum; the fleet engineer may bring an inspection forward after a defect report or a roadside stop, never push one back.

Daily. The driver completes the walk-around check before the first journey and records it in the defect app: lights, tyres and wheel nuts, mirrors, brakes, fluid levels, load security, tachograph and the trailer coupling. A defect that affects safety takes the vehicle off the road until a technician signs it off.

Six-weekly. Safety inspection of every tractor unit and rigid by the workshop, on the fixed calendar published each January. Brake performance test on a roller brake tester at every inspection, laden where possible. Trailers are inspected every eight weeks. Inspection sheets are kept for fifteen months.

Annual. MOT for every vehicle and trailer, scheduled four weeks before expiry. Tachograph calibration every two years, and any time the vehicle is re-plated or the gearbox is replaced. Tail-lift LOLER thorough examination every six months.

Tyres. Minimum tread of 3 mm on steer axles, 2 mm elsewhere (above the legal 1 mm) — replaced at the next inspection once the threshold is reached. Retreads are permitted on drive and trailer axles only.

Refrigeration units. Serviced every 1,500 running hours or six months, whichever is first; a temperature calibration check is recorded at every service and the certificate goes in the trailer file for pharmaceutical and food customers.

Defects and downtime. Every defect is closed in the app with the technician, the parts used and the time taken. Vehicle-off-road hours are reported weekly; the target is below 4% of available hours across the fleet.`,
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
            charOffset: customs.text.indexOf(customsHit.text),
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
      .onConflictDoNothing()
    await db
      .insert(agentRunEvents)
      .values(
        run.events.map((e, i) => ({
          id: demoId(`run-event:${run.agentKey}:${i + 1}`),
          runId: run.id,
          tenantId,
          seq: i + 1,
          type: e.type as (typeof agentRunEvents.$inferInsert)['type'],
          data: e.data,
          at: new Date(run.startedAt.getTime() + e.offsetSeconds * 1000),
        }))
      )
      .onConflictDoNothing()
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
