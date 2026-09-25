/**
 * OTLP identifiers (D32): a trace id is 16 bytes and a span id 8, both lowercase hex on the wire.
 *
 * An agent run's steps execute as SEPARATE Worker invocations — `execute#0`, a retry, `execute#1`
 * after a park, `finish` — and nothing is carried between them but the run row. So the run's trace
 * id and its root span id are DERIVED from the run id rather than stored: every step computes the
 * same two values, every step's spans join one trace, and each `execute#N` is a child of a root
 * that `finishStep` records once the run has settled. The derivation is a wire format — change it
 * and every stored `agent_runs.trace_id` stops matching the spans a new step writes.
 */

const HEX32 = /^[0-9a-f]{32}$/
const HEX16 = /^[0-9a-f]{16}$/

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  let out = ''
  for (const b of buf) out += b.toString(16).padStart(2, '0')
  return out
}

export const newTraceId = (): string => randomHex(16)
export const newSpanId = (): string => randomHex(8)

export const isTraceId = (value: string): boolean => HEX32.test(value) && !/^0+$/.test(value)
export const isSpanId = (value: string): boolean => HEX16.test(value) && !/^0+$/.test(value)

/** FNV-1a 64-bit — synchronous, dependency-free, enough to spread a non-uuid id over hex. */
function fnv1a64(input: string, seed: bigint): string {
  let hash = 0xcbf29ce484222325n ^ seed
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i))
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

function runHex(runId: string): string {
  const hex = runId.replace(/-/g, '').toLowerCase()
  return HEX32.test(hex) ? hex : fnv1a64(runId, 1n) + fnv1a64(runId, 2n)
}

/** The one trace every step of run `runId` lands in: the uuid's 32 hex digits. */
export function traceIdForRun(runId: string): string {
  return runHex(runId)
}

/** The run's root span (`invoke_agent <key>`), recorded by `finishStep`; the parent of every step. */
export function rootSpanIdForRun(runId: string): string {
  const id = fnv1a64(runHex(runId), 3n)
  return id === '0000000000000000' ? '0000000000000001' : id
}
