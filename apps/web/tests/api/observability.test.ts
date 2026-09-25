/**
 * Tracing (D32), no database, injected fetch: `tracerFor` picks sinks from config (no-op with
 * none; the langfuse preset from the existing keys, phoenix defaulting to protobuf); the OTLP JSON
 * request matches a fixture; handles nest (a tool call's span under the agent span, retrieval under
 * the tool); a run's trace and root ids are derived from the run id; capture-off strips content
 * before any sink sees it; the protobuf encoding decodes back to the same span.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { traceStep } from '@/api/observability/context'
import { toOtlpRequest, tracesUrl } from '@/api/observability/otlp-fetch'
import { encodeOtlpProtobuf } from '@/api/observability/otlp-protobuf'
import { createTracer, type RecordedSpan } from '@/api/observability/recorder'
import { isSpanId, isTraceId, rootSpanIdForRun, traceIdForRun } from '@/api/observability/trace-ids'
import { noopTracer } from '@/api/observability/tracer'
import {
  exporterSettings,
  parseOtlpHeaders,
  traceChatClient,
  tracerFor,
  withAgentTrace,
} from '@/api/observability/tracing'
import { runToolLoop, type Tool } from '@/api/services/ai/kit'
import { loadConfig } from '@/config'
import { FakeChatClient } from '../helpers/ai'
import { createTestEnv } from '../mocks/bindings'

function recordingFetch(status = 200) {
  const posts: { url: string; headers: Headers; body: unknown }[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    posts.push({ url: String(input), headers: new Headers(init?.headers), body: init?.body })
    return new Response('{}', { status })
  }
  return { fetchImpl, posts }
}

/** A tracer whose one sink collects what it is handed. */
function collectingTracer(captureContent = true) {
  const spans: RecordedSpan[] = []
  const tracer = createTracer({
    sinks: [async batch => void spans.push(...batch)],
    captureContent,
  })
  return { tracer, spans }
}

const cfgWith = (vars: Record<string, string>) =>
  loadConfig(createTestEnv({ LANGFUSE_PUBLIC_KEY: '', LANGFUSE_SECRET_KEY: '', ...vars }))

describe('exporter settings (presets)', () => {
  it('exports nothing without keys or an endpoint, and tracerFor is then the no-op', () => {
    const cfg = cfgWith({})
    expect(exporterSettings(cfg)).toBeNull()
    expect(tracerFor(cfg)).toBe(noopTracer)
    // …but the local store alone is enough to record.
    expect(tracerFor(cfg, { store: async () => {} }).enabled).toBe(true)
  })

  it('langfuse: Langfuse Cloud OTLP from the EXISTING keys, Basic auth + ingestion v4, no new secret', () => {
    const settings = exporterSettings(
      cfgWith({ LANGFUSE_PUBLIC_KEY: 'pk-lf-x', LANGFUSE_SECRET_KEY: 'sk-lf-y' })
    )
    expect(settings).toEqual({
      preset: 'langfuse',
      endpoint: 'https://cloud.langfuse.com/api/public/otel',
      protocol: 'http/json',
      headers: {
        authorization: `Basic ${btoa('pk-lf-x:sk-lf-y')}`,
        'x-langfuse-ingestion-version': '4',
      },
    })
    expect(tracesUrl(settings?.endpoint ?? '')).toBe(
      'https://cloud.langfuse.com/api/public/otel/v1/traces'
    )
  })

  it('langfuse without both keys has nothing to authenticate as', () => {
    expect(exporterSettings(cfgWith({ OBSERVABILITY_PRESET: 'langfuse' }))).toBeNull()
  })

  it('phoenix: needs an endpoint and defaults to protobuf; explicit headers pass through', () => {
    expect(exporterSettings(cfgWith({ OBSERVABILITY_PRESET: 'phoenix' }))).toBeNull()
    expect(
      exporterSettings(
        cfgWith({
          OBSERVABILITY_PRESET: 'phoenix',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:6006',
          OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20abc',
        })
      )
    ).toEqual({
      preset: 'phoenix',
      endpoint: 'http://localhost:6006',
      protocol: 'http/protobuf',
      headers: { authorization: 'Bearer abc' },
    })
  })

  it('generic: endpoint + headers as given, JSON unless told otherwise', () => {
    expect(
      exporterSettings(
        cfgWith({
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
          OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        })
      )
    ).toMatchObject({ preset: 'generic', protocol: 'http/protobuf', headers: {} })
  })

  it('parses OTEL_EXPORTER_OTLP_HEADERS per the spec and drops malformed pairs', () => {
    expect(parseOtlpHeaders('a=1, B = two%3D2 ,broken,=x,c=')).toEqual({ a: '1', b: 'two=2' })
    expect(parseOtlpHeaders(undefined)).toEqual({})
  })
})

describe('OTLP/JSON shape', () => {
  const span: RecordedSpan = {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    parentSpanId: '00f067aa0ba902b7',
    name: 'chat claude-sonnet-5',
    kind: 'llm',
    startTime: new Date('2026-09-25T10:00:00.000Z'),
    endTime: new Date('2026-09-25T10:00:01.500Z'),
    status: 'error',
    statusMessage: 'overloaded',
    attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 12, ratio: 0.5 },
    content: { input: 'hi', output: [{ type: 'text', text: 'yo' }] },
    root: false,
  }

  it('matches the fixture: hex ids, string nanos, typed values, ERROR status, content attributes', () => {
    expect(
      toOtlpRequest(
        [span],
        { serviceName: 'Rocketflare', serviceVersion: '1.2.3', environment: 'test' },
        { langfuse: false }
      )
    ).toEqual({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'Rocketflare' } },
              { key: 'service.version', value: { stringValue: '1.2.3' } },
              { key: 'deployment.environment.name', value: { stringValue: 'test' } },
              { key: 'telemetry.sdk.name', value: { stringValue: 'rocketflare' } },
              { key: 'telemetry.sdk.language', value: { stringValue: 'webjs' } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: 'rocketflare', version: '1.2.3' },
              spans: [
                {
                  traceId: '0af7651916cd43dd8448eb211c80319c',
                  spanId: 'b7ad6b7169203331',
                  parentSpanId: '00f067aa0ba902b7',
                  name: 'chat claude-sonnet-5',
                  kind: 3,
                  startTimeUnixNano: '1790330400000000000',
                  endTimeUnixNano: '1790330401500000000',
                  attributes: [
                    { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
                    { key: 'gen_ai.usage.input_tokens', value: { intValue: '12' } },
                    { key: 'ratio', value: { doubleValue: 0.5 } },
                    { key: 'input.value', value: { stringValue: 'hi' } },
                    { key: 'input.mime_type', value: { stringValue: 'text/plain' } },
                    {
                      key: 'output.value',
                      value: { stringValue: '[{"type":"text","text":"yo"}]' },
                    },
                    { key: 'output.mime_type', value: { stringValue: 'application/json' } },
                    { key: 'gen_ai.input.messages', value: { stringValue: 'hi' } },
                    {
                      key: 'gen_ai.output.messages',
                      value: { stringValue: '[{"type":"text","text":"yo"}]' },
                    },
                  ],
                  status: { code: 2, message: 'overloaded' },
                },
              ],
            },
          ],
        },
      ],
    })
  })

  it('adds the langfuse content aliases only under the langfuse preset', () => {
    const lf = toOtlpRequest(
      [{ ...span, root: true }],
      { serviceName: 's', serviceVersion: 'v', environment: 'e' },
      { langfuse: true }
    )
    const keys = lf.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.attributes.map(a => a.key)
    expect(keys).toEqual(
      expect.arrayContaining([
        'langfuse.observation.input',
        'langfuse.observation.output',
        'langfuse.trace.input',
        'langfuse.trace.output',
      ])
    )
  })

  it('POSTs one JSON request to <endpoint>/v1/traces with the preset headers', async () => {
    const { fetchImpl, posts } = recordingFetch()
    const tracer = tracerFor(cfgWith({ LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' }), {
      fetch: fetchImpl,
    })
    tracer.startTrace({ name: 'chat', tenantId: 't' }).end({ output: 'ok' })
    await tracer.flush()
    await tracer.flush()
    expect(posts).toHaveLength(1)
    expect(posts[0]?.url).toBe('https://cloud.langfuse.com/api/public/otel/v1/traces')
    expect(posts[0]?.headers.get('content-type')).toBe('application/json')
    expect(posts[0]?.headers.get('x-langfuse-ingestion-version')).toBe('4')
    const body = JSON.parse(String(posts[0]?.body))
    expect(body.resourceSpans[0].scopeSpans[0].spans[0].name).toBe('invoke_agent chat')
  })

  it('swallows a failing backend: flush resolves', async () => {
    const tracer = tracerFor(cfgWith({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://x.test' }), {
      fetch: async () => {
        throw new Error('network down')
      },
    })
    tracer.startTrace({ name: 'chat' }).end()
    await expect(tracer.flush()).resolves.toBeUndefined()
  })
})

describe('nesting', () => {
  it('agent → chat <model> and execute_tool <name> children; retrieval nests under the tool', async () => {
    const { tracer, spans } = collectingTracer()
    const lookup: Tool<{ q: string }> = {
      name: 'lookup',
      description: 'find things',
      schema: z.object({ q: z.string() }),
      handler: async ({ q }) =>
        traceStep({ name: 'retrieval search_chunks', kind: 'retrieval', input: { q } }, async () =>
          JSON.stringify({ hits: 1 })
        ),
    }
    const submit: Tool<{ answer: string }> = {
      name: 'submit',
      description: 'answer',
      schema: z.object({ answer: z.string() }),
    }
    const fake = new FakeChatClient([
      { toolUses: [{ id: 'call_1', name: 'lookup', input: { q: 'x' } }] },
      { toolUses: [{ name: 'submit', input: { answer: 'done' } }] },
    ])
    await withAgentTrace('research-topic', { tracer, tenantId: 't', runId: 'r' }, trace =>
      runToolLoop(traceChatClient(fake, trace, { provider: 'anthropic' }, tracer), {
        model: 'm',
        system: 's',
        messages: [{ role: 'user', content: 'go' }],
        tools: [lookup as Tool, submit as Tool],
      })
    )
    await tracer.flush()

    const root = spans.find(s => s.root)
    const tool = spans.find(s => s.kind === 'tool')
    const retrieval = spans.find(s => s.kind === 'retrieval')
    const llm = spans.filter(s => s.kind === 'llm')
    expect(root?.name).toBe('invoke_agent research-topic')
    expect(llm.map(s => s.name)).toEqual(['chat m', 'chat m'])
    expect(llm.every(s => s.parentSpanId === root?.spanId)).toBe(true)
    expect(tool).toMatchObject({
      name: 'execute_tool lookup',
      parentSpanId: root?.spanId,
      toolName: 'lookup',
      content: { input: { q: 'x' }, output: '{"hits":1}' },
    })
    expect(tool?.attributes['gen_ai.tool.call.id']).toBe('call_1')
    expect(retrieval?.parentSpanId).toBe(tool?.spanId)
    expect(new Set(spans.map(s => s.traceId)).size).toBe(1)
    expect(spans.every(s => s.attributes['rocketflare.tenant_id'] === 't')).toBe(true)
    expect(llm[0]).toMatchObject({ model: 'm', provider: 'anthropic', inputTokens: 10 })
  })

  it('a tool that answers an error is an error span; the error of the body fails the root and rethrows', async () => {
    const { tracer, spans } = collectingTracer()
    const bad: Tool<{ n: number }> = {
      name: 'bad',
      description: 'x',
      schema: z.object({ n: z.number() }),
      handler: async () => {
        throw new Error('tool broke')
      },
    }
    const fake = new FakeChatClient([
      { toolUses: [{ name: 'bad', input: { n: 1 } }] },
      { error: new Error('provider down') },
    ])
    await expect(
      withAgentTrace('a', { tracer, tenantId: 't' }, trace =>
        runToolLoop(traceChatClient(fake, trace, { provider: 'anthropic' }, tracer), {
          model: 'm',
          system: 's',
          messages: [{ role: 'user', content: 'go' }],
          tools: [bad as Tool],
        })
      )
    ).rejects.toThrow('provider down')
    await tracer.flush()
    expect(spans.find(s => s.kind === 'tool')).toMatchObject({
      status: 'error',
      statusMessage: 'tool broke',
    })
    expect(spans.find(s => s.root)).toMatchObject({
      status: 'error',
      statusMessage: 'provider down',
    })
    expect(spans.find(s => s.root)?.attributes['langfuse.observation.level']).toBe('ERROR')
  })

  it('a child never closes its parent, and end() is idempotent', async () => {
    const { tracer, spans } = collectingTracer()
    const root = tracer.startTrace({ name: 'x', tenantId: 't' })
    const child = root.span({ name: 'step' })
    child.span({ name: 'done', startTime: new Date(0), endTime: new Date(1) })
    child.end()
    child.end()
    await tracer.flush()
    expect(spans.map(s => s.name)).toEqual(['done', 'step'])
    root.end()
    await tracer.flush()
    expect(spans.map(s => s.name)).toEqual(['done', 'step', 'invoke_agent x'])
  })
})

describe('workflow trace continuity', () => {
  const runId = '3f9c2b1e-8d4a-4c6b-9e2f-1a2b3c4d5e6f'

  it('derives one stable trace id and root span id per run', () => {
    expect(traceIdForRun(runId)).toBe('3f9c2b1e8d4a4c6b9e2f1a2b3c4d5e6f')
    expect(traceIdForRun(runId)).toBe(traceIdForRun(runId.toUpperCase()))
    expect(rootSpanIdForRun(runId)).toBe(rootSpanIdForRun(runId))
    expect(isTraceId(traceIdForRun(runId))).toBe(true)
    expect(isSpanId(rootSpanIdForRun(runId))).toBe(true)
    expect(rootSpanIdForRun(runId)).not.toBe(
      rootSpanIdForRun('3f9c2b1e-8d4a-4c6b-9e2f-1a2b3c4d5e70')
    )
    // A non-uuid id still hashes to valid ids rather than throwing.
    expect(isTraceId(traceIdForRun('not-a-uuid'))).toBe(true)
  })

  it('two separate invocations (tracers) land in one trace under the derived root', async () => {
    const first = collectingTracer()
    const second = collectingTracer()
    for (const [round, { tracer }] of [first, second].entries()) {
      await withAgentTrace(
        'research-topic',
        {
          tracer,
          tenantId: 't',
          runId,
          traceId: traceIdForRun(runId),
          parentSpanId: rootSpanIdForRun(runId),
          spanName: `execute#${round}`,
          kind: 'span',
        },
        async () => 'ok'
      )
      await tracer.flush()
    }
    const steps = [...first.spans, ...second.spans]
    expect(steps.map(s => s.name)).toEqual(['execute#0', 'execute#1'])
    expect(steps.every(s => s.traceId === traceIdForRun(runId))).toBe(true)
    expect(steps.every(s => s.parentSpanId === rootSpanIdForRun(runId) && !s.root)).toBe(true)
    // A step is not the trace's root, so it does not name the trace.
    expect(steps[0]?.attributes['langfuse.trace.name']).toBeUndefined()
  })
})

describe('content capture', () => {
  it('OBSERVABILITY_CAPTURE_CONTENT=false: no content reaches any sink, nor the export', async () => {
    const { fetchImpl, posts } = recordingFetch()
    const stored: RecordedSpan[] = []
    const tracer = tracerFor(
      cfgWith({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://x.test',
        OBSERVABILITY_CAPTURE_CONTENT: 'false',
      }),
      { fetch: fetchImpl, store: async spans => void stored.push(...spans) }
    )
    await withAgentTrace('chat', { tracer, tenantId: 't', input: 'secret prompt' }, async trace => {
      trace.toolCall({
        name: 'lookup',
        input: { q: 'secret arg' },
        output: 'secret result',
        startTime: new Date(),
        endTime: new Date(),
      })
      return 'secret answer'
    })
    await tracer.flush()
    expect(stored).toHaveLength(2)
    expect(stored.every(s => s.content === null)).toBe(true)
    expect(String(posts[0]?.body)).not.toContain('secret')
    // The shape survives: names, kinds and usage are not content.
    expect(stored.map(s => s.name)).toEqual(['execute_tool lookup', 'invoke_agent chat'])
  })
})

/** Just enough protobuf to walk the encoded request back: tag → value, length-delimited kept raw. */
function decodeFields(bytes: Uint8Array): { field: number; value: bigint | Uint8Array }[] {
  const out: { field: number; value: bigint | Uint8Array }[] = []
  let i = 0
  const varint = () => {
    let result = 0n
    let shift = 0n
    for (;;) {
      const b = bytes[i++] as number
      result |= BigInt(b & 0x7f) << shift
      if ((b & 0x80) === 0) return result
      shift += 7n
    }
  }
  while (i < bytes.length) {
    const tag = Number(varint())
    const field = tag >> 3
    const wire = tag & 7
    if (wire === 0) out.push({ field, value: varint() })
    else if (wire === 1) {
      let v = 0n
      for (let k = 0; k < 8; k++) v |= BigInt(bytes[i + k] as number) << BigInt(8 * k)
      i += 8
      out.push({ field, value: v })
    } else if (wire === 2) {
      const len = Number(varint())
      out.push({ field, value: bytes.slice(i, i + len) })
      i += len
    } else throw new Error(`wire type ${wire}`)
  }
  return out
}

const sub = (fields: ReturnType<typeof decodeFields>, n: number) =>
  fields.filter(f => f.field === n).map(f => decodeFields(f.value as Uint8Array))
const text = (value: bigint | Uint8Array) => new TextDecoder().decode(value as Uint8Array)
const hex = (value: bigint | Uint8Array) =>
  Array.from(value as Uint8Array, b => b.toString(16).padStart(2, '0')).join('')

describe('OTLP/protobuf', () => {
  it('encodes the same request the JSON path builds (ids as bytes, fixed64 nanos, attributes, status)', () => {
    const request = toOtlpRequest(
      [
        {
          traceId: '0af7651916cd43dd8448eb211c80319c',
          spanId: 'b7ad6b7169203331',
          name: 'execute_tool lookup',
          kind: 'tool',
          startTime: new Date('2026-09-25T10:00:00.000Z'),
          endTime: new Date('2026-09-25T10:00:00.250Z'),
          status: 'error',
          statusMessage: 'bad',
          attributes: { 'gen_ai.tool.name': 'lookup', n: 7, flag: true },
          content: null,
          root: true,
        },
      ],
      { serviceName: 'svc', serviceVersion: '1', environment: 'test' },
      { langfuse: false }
    )
    const top = decodeFields(encodeOtlpProtobuf(request))
    const [resourceSpans] = sub(top, 1)
    const [resource] = sub(resourceSpans ?? [], 1)
    const [firstAttr] = sub(resource ?? [], 1)
    expect(text(firstAttr?.find(f => f.field === 1)?.value ?? new Uint8Array())).toBe(
      'service.name'
    )
    const [scopeSpans] = sub(resourceSpans ?? [], 2)
    const [span] = sub(scopeSpans ?? [], 2)
    const get = (n: number) => span?.find(f => f.field === n)?.value ?? new Uint8Array()
    expect(hex(get(1))).toBe('0af7651916cd43dd8448eb211c80319c')
    expect(hex(get(2))).toBe('b7ad6b7169203331')
    expect(span?.some(f => f.field === 4)).toBe(false)
    expect(text(get(5))).toBe('execute_tool lookup')
    expect(get(6)).toBe(1n)
    expect(get(7)).toBe(1790330400000000000n)
    expect(get(8)).toBe(1790330400250000000n)
    const attrs = sub(span ?? [], 9).map(kv => ({
      key: text(kv.find(f => f.field === 1)?.value ?? new Uint8Array()),
      value: decodeFields(kv.find(f => f.field === 2)?.value as Uint8Array)[0],
    }))
    expect(attrs.map(a => a.key)).toEqual(['gen_ai.tool.name', 'n', 'flag'])
    expect(text(attrs[0]?.value?.value ?? new Uint8Array())).toBe('lookup')
    expect(attrs[1]?.value).toEqual({ field: 3, value: 7n })
    expect(attrs[2]?.value).toEqual({ field: 2, value: 1n })
    const [status] = sub(span ?? [], 15)
    expect(text(status?.find(f => f.field === 2)?.value ?? new Uint8Array())).toBe('bad')
    expect(status?.find(f => f.field === 3)?.value).toBe(2n)
  })
})
