/**
 * Activity in plain words: each kit event type reads as a sentence from its own metadata, a
 * missing actor reads as "Someone" / "The system", and an unknown type still reads as words —
 * never a raw event code alone.
 */
import type { ActivityEvent } from '@rocketflare/shared/activity'
import { describe, expect, it } from 'vitest'
import {
  activityGroupSentence,
  activitySentence,
  agentKeyWords,
  groupActivity,
} from '@/ui/lib/activity-words'

const event = (
  type: string,
  metadata: Record<string, unknown> = {},
  actor: ActivityEvent['actor'] = { name: 'Ana Lopez', email: 'ana@example.test' }
) => ({ type, metadata, actor, userId: actor ? 'u1' : null })

describe('activitySentence', () => {
  it.each([
    [
      event('member.invited', { email: 'bob@example.test', role: 'member' }),
      'Ana invited bob@example.test',
    ],
    [
      event('member.invited', { email: 'bob@example.test', role: 'admin' }),
      'Ana invited bob@example.test as admin',
    ],
    [event('member.bulk_invited', { invited: 3 }), 'Ana invited 3 people'],
    [event('member.joined', { via: 'invitation' }), 'Ana joined'],
    [event('api_key.created', { name: 'CI' }), 'Ana created the API key “CI”'],
    [
      event('api_key.created', { name: 'cli:host', via: 'cli' }),
      'Ana signed in from the command line',
    ],
    [event('agent_run.requested', { agentKey: 'weekly-digest' }), 'Ana started Weekly digest'],
    [event('document.deleted', { title: 'Old policy' }), 'Ana deleted “Old policy”'],
    [event('document.deleted', {}), 'Ana deleted a document'],
    [event('ai_config.created', { scope: 'chat' }), 'Ana connected a model for chat'],
    [event('group.member_added', { userIds: ['a', 'b'] }), 'Ana added 2 people to a group'],
    [event('tenant.created', {}), 'Ana created the organisation'],
  ])('%#: %s', (input, expected) => {
    expect(activitySentence(input)).toBe(expected)
  })

  it('says what happened when there is no one of the team to name', () => {
    expect(activitySentence({ ...event('tenant.created', {}, null), userId: 'gone' })).toBe(
      'The organisation was created'
    )
    expect(activitySentence(event('agent_run.requested', { agentKey: 'triage' }, null))).toBe(
      'A run of Triage started'
    )
    expect(activitySentence(event('ai_config.created', { scope: 'decisions' }, null))).toBe(
      'A model was connected for decisions'
    )
    expect(activitySentence(event('tenant.suspended', {}, null))).toBe(
      'The organisation was suspended'
    )
    // No passive wording for it: "Someone", or the event in words.
    expect(activitySentence({ ...event('support.left', {}, null), userId: 'x' })).toBe(
      'Someone finished giving support'
    )
    expect(activitySentence(event('example.widget_created', {}, null))).toBe(
      'Example widget created'
    )
  })

  it('reads an unknown type as words', () => {
    expect(activitySentence(event('example.widget_created'))).toBe('Ana: example widget created')
  })

  it('ignores metadata of the wrong shape', () => {
    expect(activitySentence(event('member.invited', { email: 42, role: 'boss' }))).toBe(
      'Ana invited someone'
    )
  })

  it('reads an agent key as words', () => {
    expect(agentKeyWords('draft_reply')).toBe('Draft reply')
    expect(agentKeyWords(undefined)).toBe('an agent')
  })
})

describe('groupActivity', () => {
  const marcus = { name: 'Marcus Webb', email: 'marcus@example.test' }
  let n = 0
  const ev = (type: string, actor = marcus, metadata: Record<string, unknown> = {}) => ({
    ...event(type, metadata, actor),
    userId: actor.email,
    id: `e${n++}`,
  })

  it('folds consecutive repeats by one person into one line, keeping order', () => {
    const groups = groupActivity([
      ev('conversation.created'),
      ev('conversation.created'),
      ev('conversation.created'),
      ev('conversation.created'),
      ev('document.ingested'),
      ev('conversation.created', { name: 'Ana Lopez', email: 'ana@example.test' }),
      ev('conversation.created'),
    ])
    expect(groups.map(activityGroupSentence)).toEqual([
      'Marcus started 4 conversations',
      'Marcus added a document',
      'Ana started a conversation',
      'Marcus started a conversation',
    ])
  })

  it('keeps runs of different agents apart, and says "n times" for a type with no plural', () => {
    const groups = groupActivity([
      ev('agent_run.requested', marcus, { agentKey: 'plan-trip' }),
      ev('agent_run.requested', marcus, { agentKey: 'plan-trip' }),
      ev('agent_run.requested', marcus, { agentKey: 'tidy-notes' }),
      ev('prompt.overridden'),
      ev('prompt.overridden'),
    ])
    expect(groups.map(activityGroupSentence)).toEqual([
      'Marcus started 2 runs of Plan trip',
      'Marcus started Tidy notes',
      'Marcus edited a prompt, 2 times',
    ])
  })
})
