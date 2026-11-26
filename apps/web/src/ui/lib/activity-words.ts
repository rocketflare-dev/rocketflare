/**
 * An activity event in plain words: "Olivia invited bob@example.com", never `member.invited`.
 * One function per event type the kit records, reading only what that type's `metadata` carries;
 * an event this table does not know (a plugin's, a newer kit's) still reads as a sentence, built
 * from its type. Pure, so the wording is tested without rendering anything.
 */
import type { ActivityEvent } from '@rocketflare/shared/activity'
import { roleLabel, tenantRoleSchema } from '@rocketflare/shared/tenants'

type Words = (actor: string, meta: Record<string, unknown>) => string

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const quoted = (value: unknown, fallback: string) => {
  const s = str(value)
  return s ? `“${s}”` : fallback
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** `research-topic` → `Research topic` — the agent's key read as words. */
export function agentKeyWords(key: unknown): string {
  const s = str(key)
  if (!s) return 'an agent'
  const words = s.replace(/[-_.]+/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function asRole(value: unknown): string | null {
  const parsed = tenantRoleSchema.safeParse(value)
  return parsed.success ? roleLabel(parsed.data).toLowerCase() : null
}

const SCOPE_WORDS: Record<string, string> = {
  chat: 'chat',
  embeddings: 'search',
  decisions: 'decisions',
  rerank: 'ranking',
}

const WORDS: Record<string, Words> = {
  'tenant.created': a => `${a} created the organisation`,
  'tenant.updated': a => `${a} updated the organisation’s details`,
  'tenant.settings_updated': a => `${a} changed the organisation’s settings`,
  'tenant.suspended': () => 'The organisation was suspended',
  'tenant.reactivated': () => 'The organisation was reactivated',
  'tenant.idp_linked': a => `${a} linked the organisation to its identity provider`,
  'tenant.idp_unlinked': a => `${a} unlinked the organisation from its identity provider`,

  'member.invited': (a, m) => {
    const role = asRole(m.role)
    const who = str(m.email) ?? 'someone'
    return role && role !== 'member' ? `${a} invited ${who} as ${role}` : `${a} invited ${who}`
  },
  'member.bulk_invited': (a, m) =>
    `${a} invited ${plural(num(m.invited) ?? 0, 'person', 'people')}`,
  'member.joined': (a, m) =>
    m.via === 'access_request' ? `${a} joined after their request was approved` : `${a} joined`,
  'member.role_changed': (a, m) => {
    const role = asRole(m.to)
    return role
      ? `${a} is now ${role === 'admin' ? 'an admin' : `a ${role}`}`
      : `${a}’s role changed`
  },
  'member.removed': a => `${a} removed someone from the organisation`,
  'invitation.resent': a => `${a} resent an invitation`,
  'invitation.revoked': a => `${a} cancelled an invitation`,
  'support.entered': a => `${a} joined to give support`,
  'support.left': a => `${a} finished giving support`,

  'api_key.created': (a, m) =>
    m.via === 'cli'
      ? `${a} signed in from the command line`
      : `${a} created the API key ${quoted(m.name, '')}`.trimEnd(),
  'api_key.revoked': (a, m) => `${a} revoked the API key ${quoted(m.name, '')}`.trimEnd(),

  'group.created': (a, m) => `${a} created the group ${quoted(m.name, '')}`.trimEnd(),
  'group.updated': (a, m) => `${a} updated the group ${quoted(m.name, '')}`.trimEnd(),
  'group.deleted': (a, m) => `${a} deleted the group ${quoted(m.name, '')}`.trimEnd(),
  'group.member_added': (a, m) => {
    const n = Array.isArray(m.userIds) ? m.userIds.length : 0
    return n > 0
      ? `${a} added ${plural(n, 'person', 'people')} to a group`
      : `${a} added people to a group`
  },
  'group.member_removed': a => `${a} removed someone from a group`,
  'group.member_changed': a => `${a} changed someone’s groups`,
  'group_type.created': (a, m) => `${a} created the group type ${quoted(m.name, '')}`.trimEnd(),
  'group_type.updated': (a, m) => `${a} updated the group type ${quoted(m.name, '')}`.trimEnd(),
  'group_type.deleted': a => `${a} deleted a group type`,

  'ai_config.created': (a, m) =>
    `${a} connected a model for ${SCOPE_WORDS[str(m.scope) ?? ''] ?? 'AI'}`,
  'ai_config.updated': (a, m) =>
    `${a} changed the model for ${SCOPE_WORDS[str(m.scope) ?? ''] ?? 'AI'}`,
  'ai_config.deleted': (a, m) =>
    `${a} removed a model for ${SCOPE_WORDS[str(m.scope) ?? ''] ?? 'AI'}`,
  'agent_model.assigned': a => `${a} chose the model an agent uses`,
  'agent_model.reverted': a => `${a} reset an agent to the default model`,
  'prompt.overridden': a => `${a} edited a prompt`,
  'prompt.reverted': a => `${a} restored a prompt to its default`,

  'conversation.created': a => `${a} started a conversation`,

  'agent_run.requested': (a, m) => `${a} started ${agentKeyWords(m.agentKey)}`,
  'agent_run.batch_requested': (a, m) =>
    `${a} started ${plural(num(m.created) ?? 0, 'run')} of ${agentKeyWords(m.agentKey)}`,
  'agent_run.cancelled': (a, m) => `${a} cancelled a run of ${agentKeyWords(m.agentKey)}`,
  'agent_run.cancel_requested': (a, m) =>
    `${a} asked to stop a run of ${agentKeyWords(m.agentKey)}`,
  'agent_run.interrupt_resolved': (a, m) =>
    `${a} answered a question from ${agentKeyWords(m.agentKey)}`,

  'document.ingested': a => `${a} added a document`,
  'document.deleted': (a, m) => `${a} deleted ${quoted(m.title, 'a document')}`,
  'document.retried': a => `${a} retried indexing a document`,
  'document.visibility_changed': a => `${a} changed who can see a document`,
  'document.reembed_requested': a => `${a} asked to re-index the knowledge base`,
  'document.contextualize_requested': a => `${a} asked for passages to be put in context`,
  'file.uploaded': (a, m) => `${a} uploaded ${quoted(m.filename, 'a file')}`,
  'file.deleted': a => `${a} deleted a file`,

  'knowledge.fact.reviewed': (a, m) =>
    m.action === 'reject'
      ? `${a} rejected a fact`
      : m.action === 'accept' || m.action === 'confirm'
        ? `${a} confirmed a fact`
        : `${a} reviewed a fact`,
  'knowledge.entity.promoted': a => `${a} added an entity to the records`,
  'knowledge.entity.merged': a => `${a} merged two entities`,
  'knowledge.entity.kept_separate': a => `${a} kept two entities apart`,

  'mcp.enabled': a => `${a} turned on the MCP server`,
  'mcp.disabled': a => `${a} turned off the MCP server`,
  'mcp.exposure_changed': a => `${a} changed which tools AI clients can use`,
  'mcp.connect_policy_changed': a => `${a} changed who may connect an AI client`,
  'mcp.client_connected': a => `${a} connected an AI client`,
  'mcp.client_revoked': a => `${a} disconnected an AI client`,
}

const scopeWords = (m: Record<string, unknown>) => SCOPE_WORDS[str(m.scope) ?? ''] ?? 'AI'

/**
 * The same events with nobody named: the actor is not one of the team (a platform admin, support,
 * someone since removed) or there was no person at all. "A model was connected for decisions"
 * reads better than an unfamiliar name or "Someone".
 */
const PASSIVE: Record<string, (meta: Record<string, unknown>) => string> = {
  'tenant.created': () => 'The organisation was created',
  'tenant.updated': () => 'The organisation’s details were updated',
  'tenant.settings_updated': () => 'The organisation’s settings were changed',
  'member.invited': m => `${str(m.email) ?? 'Someone'} was invited`,
  'member.bulk_invited': m => `${plural(num(m.invited) ?? 0, 'person was', 'people were')} invited`,
  'member.removed': () => 'Someone was removed from the organisation',
  'invitation.resent': () => 'An invitation was resent',
  'invitation.revoked': () => 'An invitation was cancelled',
  'api_key.created': m => `The API key ${quoted(m.name, '')} was created`.replace('  ', ' '),
  'api_key.revoked': m => `The API key ${quoted(m.name, '')} was revoked`.replace('  ', ' '),
  'group.created': m => `The group ${quoted(m.name, '')} was created`.replace('  ', ' '),
  'group.member_changed': () => 'Someone’s groups were changed',
  'ai_config.created': m => `A model was connected for ${scopeWords(m)}`,
  'ai_config.updated': m => `The model for ${scopeWords(m)} was changed`,
  'ai_config.deleted': m => `A model for ${scopeWords(m)} was removed`,
  'agent_model.assigned': () => 'An agent was given a different model',
  'agent_model.reverted': () => 'An agent went back to the default model',
  'prompt.overridden': () => 'A prompt was edited',
  'prompt.reverted': () => 'A prompt was restored to its default',
  'conversation.created': () => 'A conversation was started',
  'agent_run.requested': m => `A run of ${agentKeyWords(m.agentKey)} started`,
  'agent_run.batch_requested': m =>
    `${plural(num(m.created) ?? 0, 'run')} of ${agentKeyWords(m.agentKey)} started`,
  'agent_run.cancelled': m => `A run of ${agentKeyWords(m.agentKey)} was cancelled`,
  'agent_run.interrupt_resolved': m => `A question from ${agentKeyWords(m.agentKey)} was answered`,
  'document.ingested': () => 'A document was added',
  'document.deleted': m => `${quoted(m.title, 'A document')} was deleted`,
  'document.retried': () => 'A document was sent for indexing again',
  'document.visibility_changed': () => 'Who can see a document changed',
  'file.uploaded': m => `${quoted(m.filename, 'A file')} was uploaded`,
  'knowledge.fact.reviewed': () => 'A fact was reviewed',
  'knowledge.entity.merged': () => 'Two entities were merged',
  'mcp.enabled': () => 'The MCP server was turned on',
  'mcp.disabled': () => 'The MCP server was turned off',
  'mcp.client_connected': () => 'An AI client was connected',
}

/** `example.widget_created` → `example widget created`. */
function typeWords(type: string): string {
  return type.replace(/[._]+/g, ' ').trim()
}

/** The actor's first name, or `null` when there is no one of the team to name. */
export function actorWords(event: Pick<ActivityEvent, 'actor'>): string | null {
  const name = event.actor?.name?.trim()
  return name ? (name.split(/\s+/)[0] ?? name) : null
}

/** The event as one sentence: the person who did it, else what happened. */
export function activitySentence(
  event: Pick<ActivityEvent, 'type' | 'metadata' | 'actor' | 'userId'>
): string {
  const actor = actorWords(event)
  const meta = event.metadata ?? {}
  const words = WORDS[event.type]
  if (actor === null) {
    const passive = PASSIVE[event.type]
    if (passive) return passive(meta)
  }
  const subject = actor ?? (event.userId ? 'Someone' : 'The system')
  if (words) return words(subject, meta)
  const what = typeWords(event.type)
  return actor === null ? what.charAt(0).toUpperCase() + what.slice(1) : `${actor}: ${what}`
}

/** The same event done `n` times by one person, in one sentence. Types without one say "n times". */
const MANY: Record<string, (actor: string, n: number, meta: Record<string, unknown>) => string> = {
  'conversation.created': (a, n) => `${a} started ${plural(n, 'conversation')}`,
  'document.ingested': (a, n) => `${a} added ${plural(n, 'document')}`,
  'file.uploaded': (a, n) => `${a} uploaded ${plural(n, 'file')}`,
  'agent_run.requested': (a, n, m) =>
    `${a} started ${plural(n, 'run')} of ${agentKeyWords(m.agentKey)}`,
  'knowledge.fact.reviewed': (a, n) => `${a} reviewed ${plural(n, 'fact')}`,
  'member.invited': (a, n) => `${a} invited ${plural(n, 'person', 'people')}`,
}

type GroupKeyed = Pick<ActivityEvent, 'id' | 'type' | 'metadata' | 'actor' | 'userId'>

/** Consecutive events of one type by one person, the newest first: what a feed shows as one line. */
export interface ActivityGroup<E extends GroupKeyed = ActivityEvent> {
  /** The newest event of the run: its id keys the line, its time is the line's time. */
  event: E
  count: number
}

const groupKey = (e: GroupKeyed) =>
  [
    e.userId ?? '',
    e.actor?.name ?? '',
    e.type,
    // Runs of different agents are different things.
    e.type === 'agent_run.requested' ? String(e.metadata?.agentKey ?? '') : '',
  ].join('\u0000')

/** Folds consecutive identical actor + type into one group, keeping order. Pure. */
export function groupActivity<E extends GroupKeyed>(events: readonly E[]): ActivityGroup<E>[] {
  const out: ActivityGroup<E>[] = []
  for (const event of events) {
    const last = out[out.length - 1]
    if (last && groupKey(last.event) === groupKey(event)) last.count++
    else out.push({ event, count: 1 })
  }
  return out
}

/** One group as a sentence: "Marcus started 4 conversations". */
export function activityGroupSentence(group: ActivityGroup<GroupKeyed>): string {
  const { event, count } = group
  if (count === 1) return activitySentence(event)
  const actor = actorWords(event)
  const many = MANY[event.type]
  if (actor !== null && many) return many(actor, count, event.metadata ?? {})
  return `${activitySentence(event)}, ${count} times`
}
