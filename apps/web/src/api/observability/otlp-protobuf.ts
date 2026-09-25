/**
 * `ExportTraceServiceRequest` as protobuf, hand-encoded (D32). Needed because the OTLP/HTTP spec
 * makes JSON optional and some backends — Arize Phoenix among them — accept only
 * `application/x-protobuf`. The request is the SAME model the JSON path serialises, so the two
 * cannot drift; only the fields the kit writes are encoded. Field numbers are from
 * `opentelemetry/proto/{collector/trace,trace,resource,common}/v1/*.proto` and are a wire format.
 */
import type { OtlpAnyValue, OtlpExportRequest, OtlpKeyValue, OtlpSpan } from './otlp-fetch'

class Writer {
  private chunks: number[] = []

  bytes(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.chunks)
  }

  private varint(value: bigint) {
    let v = value
    while (v > 0x7fn) {
      this.chunks.push(Number((v & 0x7fn) | 0x80n))
      v >>= 7n
    }
    this.chunks.push(Number(v))
  }

  private tag(field: number, wireType: number) {
    this.varint(BigInt((field << 3) | wireType))
  }

  uint(field: number, value: number | bigint) {
    this.tag(field, 0)
    // int64: a negative is its two's complement over 64 bits.
    const v = BigInt(value)
    this.varint(v < 0n ? v + (1n << 64n) : v)
  }

  bool(field: number, value: boolean) {
    this.tag(field, 0)
    this.chunks.push(value ? 1 : 0)
  }

  fixed64(field: number, value: bigint) {
    this.tag(field, 1)
    let v = value
    for (let i = 0; i < 8; i++) {
      this.chunks.push(Number(v & 0xffn))
      v >>= 8n
    }
  }

  double(field: number, value: number) {
    this.tag(field, 1)
    const buf = new DataView(new ArrayBuffer(8))
    buf.setFloat64(0, value, true)
    for (let i = 0; i < 8; i++) this.chunks.push(buf.getUint8(i))
  }

  raw(field: number, bytes: Uint8Array) {
    this.tag(field, 2)
    this.varint(BigInt(bytes.length))
    for (const b of bytes) this.chunks.push(b)
  }

  string(field: number, value: string) {
    this.raw(field, new TextEncoder().encode(value))
  }

  message(field: number, build: (w: Writer) => void) {
    const inner = new Writer()
    build(inner)
    this.raw(field, inner.bytes())
  }
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** AnyValue: 1 string · 2 bool · 3 int64 · 4 double · 5 ArrayValue{1 values}. */
function anyValue(w: Writer, value: OtlpAnyValue) {
  if ('stringValue' in value) w.string(1, value.stringValue)
  else if ('boolValue' in value) w.bool(2, value.boolValue)
  else if ('intValue' in value) w.uint(3, BigInt(value.intValue))
  else if ('doubleValue' in value) w.double(4, value.doubleValue)
  else if ('arrayValue' in value) {
    w.message(5, arr => {
      for (const item of value.arrayValue.values) arr.message(1, v => anyValue(v, item))
    })
  }
}

/** KeyValue: 1 key · 2 value. */
function keyValues(w: Writer, field: number, attributes: OtlpKeyValue[]) {
  for (const kv of attributes) {
    w.message(field, m => {
      m.string(1, kv.key)
      m.message(2, v => anyValue(v, kv.value))
    })
  }
}

/**
 * Span: 1 trace_id · 2 span_id · 4 parent_span_id · 5 name · 6 kind · 7 start (fixed64) ·
 * 8 end (fixed64) · 9 attributes · 15 status{2 message · 3 code}.
 */
function span(w: Writer, s: OtlpSpan) {
  w.raw(1, hexBytes(s.traceId))
  w.raw(2, hexBytes(s.spanId))
  if (s.parentSpanId) w.raw(4, hexBytes(s.parentSpanId))
  w.string(5, s.name)
  w.uint(6, s.kind)
  w.fixed64(7, BigInt(s.startTimeUnixNano))
  w.fixed64(8, BigInt(s.endTimeUnixNano))
  keyValues(w, 9, s.attributes)
  if (s.status.code !== 0 || s.status.message) {
    w.message(15, st => {
      if (s.status.message) st.string(2, s.status.message)
      if (s.status.code !== 0) st.uint(3, s.status.code)
    })
  }
}

/**
 * ExportTraceServiceRequest{1 resource_spans} → ResourceSpans{1 resource{1 attributes} ·
 * 2 scope_spans} → ScopeSpans{1 scope{1 name · 2 version} · 2 spans}.
 */
export function encodeOtlpProtobuf(request: OtlpExportRequest): Uint8Array<ArrayBuffer> {
  const w = new Writer()
  for (const rs of request.resourceSpans) {
    w.message(1, r => {
      r.message(1, res => keyValues(res, 1, rs.resource.attributes))
      for (const ss of rs.scopeSpans) {
        r.message(2, sc => {
          sc.message(1, scope => {
            scope.string(1, ss.scope.name)
            if (ss.scope.version) scope.string(2, ss.scope.version)
          })
          for (const s of ss.spans) sc.message(2, m => span(m, s))
        })
      }
    })
  }
  return w.bytes()
}
