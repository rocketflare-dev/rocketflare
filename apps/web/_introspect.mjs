import * as proto from '@ag-ui/proto'

for (const ev of [
  { type: 'TOOL_CALL_RESULT', messageId: 'm', toolCallId: 't', content: '{"a":1}', role: 'tool' },
  { type: 'RUN_ERROR', message: 'boom', code: 'unavailable' },
  { type: 'STEP_STARTED', stepName: 'execute' },
  { type: 'TOOL_CALL_START', toolCallId: 't', toolCallName: 'search', parentMessageId: 'm' },
  { type: 'TOOL_CALL_ARGS', toolCallId: 't', delta: '{}' },
  { type: 'TOOL_CALL_END', toolCallId: 't' },
]) {
  try {
    const bin = proto.encode(ev)
    console.log(ev.type, 'enc ok', bin.length, JSON.stringify(proto.decode(bin)))
  } catch (e) {
    console.log(ev.type, 'FAIL', e.message)
  }
}
