/**
 * Inbound email dispatcher (`api/email.ts`): a message reaches the plugin handler that owns
 * its recipient's local part, a message nobody claims is rejected, and a handler failure is
 * rethrown (a temporary failure the sender retries) rather than turned into a bounce.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  dispatchEmail,
  EMAIL_CATCH_ALL,
  type EmailHandler,
  email,
  emailLocalPart,
  emailSubaddress,
  resolveEmailHandler,
} from '@/api/email'
import { createExecutionContext, createTestEnv, waitOnExecutionContext } from '../mocks/bindings'

/** The slice of `ForwardableEmailMessage` the dispatcher touches, plus spies. */
function fakeMessage(to: string, from = 'sender@example.com') {
  return {
    to,
    from,
    headers: new Headers({ subject: 'hello' }),
    raw: new Response('Subject: hello\r\n\r\nbody').body as ReadableStream,
    rawSize: 24,
    canBeForwarded: true,
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage & { setReject: ReturnType<typeof vi.fn> }
}

function handler(localPart: string, name = localPart): EmailHandler & { seen: string[] } {
  const seen: string[] = []
  return {
    localPart,
    name,
    seen,
    async handle(message, ctx) {
      expect(ctx.db).toBeDefined()
      expect(ctx.config).toBeDefined()
      seen.push(message.to)
    },
  }
}

describe('email address helpers', () => {
  it('takes the local part lower-cased and without the subaddress', () => {
    expect(emailLocalPart('Receipts+Proton@Example.com')).toBe('receipts')
    expect(emailLocalPart('receipts@example.com')).toBe('receipts')
    expect(emailLocalPart('a+b+c@example.com')).toBe('a')
  })

  it('reads the subaddress, null when there is none', () => {
    expect(emailSubaddress('receipts+Proton@example.com')).toBe('proton')
    expect(emailSubaddress('receipts@example.com')).toBeNull()
    expect(emailSubaddress('receipts+@example.com')).toBeNull()
  })

  it('resolves an exact local part before the catch-all', () => {
    const receipts = handler('receipts')
    const all = handler(EMAIL_CATCH_ALL, 'all')
    expect(resolveEmailHandler('receipts+x@example.com', [all, receipts])).toBe(receipts)
    expect(resolveEmailHandler('other@example.com', [all, receipts])).toBe(all)
    expect(resolveEmailHandler('other@example.com', [receipts])).toBeUndefined()
  })
})

describe('email dispatcher', () => {
  it('hands the message to the matching handler with a DB client', async () => {
    const receipts = handler('receipts')
    const message = fakeMessage('receipts+gmail@example.com')
    const ctx = createExecutionContext()
    await dispatchEmail(message, createTestEnv(), ctx, [receipts])
    await waitOnExecutionContext(ctx)
    expect(receipts.seen).toEqual(['receipts+gmail@example.com'])
    expect(message.setReject).not.toHaveBeenCalled()
  })

  it('rejects a message no handler claims', async () => {
    const message = fakeMessage('nobody@example.com')
    const ctx = createExecutionContext()
    await dispatchEmail(message, createTestEnv(), ctx, [handler('receipts')])
    await waitOnExecutionContext(ctx)
    expect(message.setReject).toHaveBeenCalledWith('Unknown recipient')
  })

  it('rethrows a handler failure so the sender retries, and never rejects it', async () => {
    const boom: EmailHandler = {
      localPart: 'receipts',
      name: 'boom',
      handle: async () => {
        throw new Error('database down')
      },
    }
    const message = fakeMessage('receipts@example.com')
    const ctx = createExecutionContext()
    await expect(dispatchEmail(message, createTestEnv(), ctx, [boom])).rejects.toThrow(
      'database down'
    )
    await waitOnExecutionContext(ctx)
    expect(message.setReject).not.toHaveBeenCalled()
  })

  it('the Worker handler rejects an address no installed plugin claims', async () => {
    const message = fakeMessage('definitely-unclaimed-address@example.com')
    const ctx = createExecutionContext()
    await email(message, createTestEnv(), ctx)
    await waitOnExecutionContext(ctx)
    expect(message.setReject).toHaveBeenCalledWith('Unknown recipient')
  })
})
