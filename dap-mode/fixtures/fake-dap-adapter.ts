import { ContentLengthMessageParser, serializeContentLength } from "../content-length"
import { appendFileSync } from "node:fs"
import type { DapMessage, DapRequest, DapResponse } from "../types"

const parser = new ContentLengthMessageParser<DapMessage>()
let sequence = 0
let launchRequest: DapRequest | undefined

function send(message: DapMessage): void { process.stdout.write(serializeContentLength(message)) }
function respond(request: DapRequest, body: Record<string, unknown> = {}): void {
  const response: DapResponse = { seq: ++sequence, type: "response", request_seq: request.seq, success: true, command: request.command, body }
  send(response)
}
function event(name: string, body: Record<string, unknown> = {}): void { send({ seq: ++sequence, type: "event", event: name, body }) }

function handle(request: DapRequest): void {
  const log = process.env.FAKE_DAP_LOG
  if (log) appendFileSync(log, `${process.pid} ${request.command}\n`)
  switch (request.command) {
    case "initialize":
      respond(request, {
        supportsConfigurationDoneRequest: true,
        supportsTerminateRequest: true,
        supportsRestartRequest: true,
        supportsTerminateThreadsRequest: true,
        supportsSetVariable: true,
        supportsCompletionsRequest: true,
        supportsSourceRequest: true,
        supportsExceptionInfoRequest: true,
      })
      break
    case "launch":
    case "attach":
      launchRequest = request
      event("initialized")
      event("loadedSource", { reason: "new", source: { name: "virtual.py", sourceReference: 77 } })
      break
    case "setBreakpoints": {
      const points = Array.isArray(request.arguments?.breakpoints) ? request.arguments.breakpoints as Array<{ line: number }> : []
      respond(request, { breakpoints: points.map(point => ({ verified: true, line: point.line })) })
      break
    }
    case "configurationDone":
      respond(request)
      if (launchRequest) { respond(launchRequest); launchRequest = undefined }
      break
    case "threads": respond(request, { threads: [{ id: 1, name: "main" }] }); break
    case "pause": respond(request); event("stopped", { reason: "pause", threadId: 1 }); break
    case "stackTrace": respond(request, { stackFrames: [{ id: 10, name: "main", source: { name: "fake.ts", path: "/tmp/fake.ts" }, line: 4, column: 1 }] }); break
    case "scopes": respond(request, { scopes: [{ name: "Locals", variablesReference: 20, expensive: false }] }); break
    case "variables": respond(request, { variables: [
      { name: "answer", value: "42", type: "number", variablesReference: 0 },
      { name: "obj", value: "{…}", type: "object", variablesReference: 21 },
    ] }); break
    case "evaluate": respond(request, { result: "42", type: "number", variablesReference: 0 }); break
    case "setVariable": respond(request, { value: String(request.arguments?.value ?? ""), variablesReference: 0 }); break
    case "completions": respond(request, { targets: [{ label: "answer", text: "answer", type: "variable" }] }); break
    case "source": respond(request, { content: "# virtual source\nanswer = 42\n", mimeType: "text/x-python" }); break
    case "terminateThreads": respond(request); break
    case "continue": respond(request); event("continued", { threadId: 1, allThreadsContinued: true }); break
    case "restart": respond(request); break
    case "terminate": respond(request); break
    case "disconnect": respond(request); event("terminated"); setTimeout(() => process.exit(0), 5); break
    default: respond(request)
  }
}

process.stdin.on("data", chunk => {
  const input = typeof chunk === "string" ? chunk : new Uint8Array(chunk)
  for (const message of parser.feed(input)) if (message.type === "request") handle(message)
})
