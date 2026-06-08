import type { BufferModel } from "@jemacs/core"
import type { FaceName, TextSpan } from "@jemacs/core/modes/mode"
import { describeJagentSettings } from "./provider"
import type { JagentEvent, JagentMessage, JagentSettings, JagentToolResult } from "./types"

export const JAGENT_SECTIONS = "jagent-sections"

type JagentSectionKind =
  | "banner"
  | "header"
  | "user"
  | "assistant"
  | "tool"
  | "tool-ok"
  | "tool-error"
  | "muted"
  | "error"
  | "pending"

type JagentSection = {
  start: number
  end: number
  kind: JagentSectionKind
}

type Rendered = {
  text: string
  sections: JagentSection[]
}

const WIDTH = 78

function nowTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  } catch {
    return iso
  }
}

function divider(label: string, right = ""): string {
  const inner = right ? `${label}  ${right}` : label
  const fill = Math.max(2, WIDTH - inner.length - 4)
  return `+- ${inner} ${"-".repeat(fill)}+\n`
}

function push(sections: JagentSection[], state: { text: string }, chunk: string, kind: JagentSectionKind): void {
  const start = state.text.length
  state.text += chunk
  sections.push({ start, end: state.text.length, kind })
}

function oneLine(text: string, max = 96): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length <= max ? line : line.slice(0, max - 1) + "..."
}

function renderToolResult(result: JagentToolResult): string {
  const status = result.ok ? "ok" : "error"
  const elapsed = result.elapsedMs == null ? "" : ` ${result.elapsedMs} ms`
  return `${result.name} ${status}${elapsed}\n${result.output.trimEnd()}\n`
}

export function summarizeEvent(event: JagentEvent): string {
  switch (event.type) {
    case "session": return event.text
    case "model": return event.text
    case "tool_start": return `running ${event.call.name} ${JSON.stringify(event.call.args)}`
    case "tool_end": return `${event.result.name} ${event.result.ok ? "ok" : "failed"}`
    case "error": return event.text
  }
}

export function renderJagentTranscript(
  messages: JagentMessage[],
  events: JagentEvent[],
  settings: JagentSettings,
  cwd: string,
  pending = false,
): Rendered {
  const sections: JagentSection[] = []
  const state = { text: "" }
  const modelLabel = describeJagentSettings(settings)

  push(sections, state, divider("Jagent Agent", `${modelLabel} @ ${cwd}`), "banner")
  push(sections, state,
    "i/RET prompt  b buffer context  s sessions  n new session  a abort  c clear  t terminal  g redraw  q bury\n\n",
    "muted")

  const recentEvents = events.slice(-5)
  if (recentEvents.length) {
    push(sections, state, "Status\n", "header")
    for (const event of recentEvents) {
      const kind: JagentSectionKind = event.type === "error" ? "error" : event.type === "tool_start" ? "pending" : "muted"
      push(sections, state, `  ${nowTime(event.at)}  ${summarizeEvent(event)}\n`, kind)
    }
    push(sections, state, "\n", "muted")
  }

  if (messages.length === 0) {
    push(sections, state,
      "This is a native Jemacs agent package. It uses jterm for shell/tool execution and keeps the conversation in this buffer.\n\n",
      "assistant")
  }

  for (const message of messages) {
    if (message.role === "user") {
      push(sections, state, divider("You", nowTime(message.at)), "header")
      push(sections, state, message.content.trimEnd() + "\n\n", "user")
    } else if (message.role === "assistant") {
      const tools = message.toolCalls?.length ? `tools ${message.toolCalls.map(call => call.name).join(", ")}` : ""
      push(sections, state, divider("Jagent", [nowTime(message.at), tools].filter(Boolean).join("  ")), "header")
      push(sections, state, (message.content.trimEnd() || "(tool request)") + "\n\n", "assistant")
    } else {
      const kind = message.result.ok ? "tool-ok" : "tool-error"
      push(sections, state, divider("Tool", `${message.result.name}  ${nowTime(message.at)}`), kind)
      push(sections, state, renderToolResult(message.result) + "\n", "tool")
    }
  }

  if (pending) {
    push(sections, state, divider("Jagent", "working"), "pending")
    push(sections, state, "Waiting for model or jterm tool output...\n", "pending")
  }

  return { text: state.text, sections }
}

const FACE_BY_KIND: Record<JagentSectionKind, FaceName> = {
  banner: "title" as FaceName,
  header: "keyword",
  user: "string",
  assistant: "default",
  tool: "comment",
  "tool-ok": "function-name" as FaceName,
  "tool-error": "error",
  muted: "comment",
  error: "error",
  pending: "warning" as FaceName,
}

export function jagentFontLock(buffer: BufferModel): TextSpan[] {
  const sections = (buffer.locals.get(JAGENT_SECTIONS) as JagentSection[] | undefined) ?? []
  const spans: TextSpan[] = []
  for (const section of sections) {
    if (section.end <= section.start) continue
    spans.push({
      start: section.start,
      end: Math.min(section.end, buffer.text.length),
      face: FACE_BY_KIND[section.kind],
    })
  }
  highlightMarkdown(buffer.text, spans)
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

function highlightMarkdown(text: string, spans: TextSpan[]): void {
  const patterns: Array<[RegExp, FaceName]> = [
    [/`[^`\n]+`/g, "builtin" as FaceName],
    [/\*\*[^*\n]+\*\*/g, "keyword"],
    [/^#{1,6} .+$/gm, "title" as FaceName],
  ]
  for (const [pattern, face] of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text))) {
      const start = match.index
      const end = start + match[0].length
      if (!spans.some(span => span.start <= start && span.end >= end)) spans.push({ start, end, face })
    }
  }
}

export function refreshJagentBuffer(
  buffer: BufferModel,
  messages: JagentMessage[],
  events: JagentEvent[],
  settings: JagentSettings,
  cwd: string,
  pending = false,
): void {
  const rendered = renderJagentTranscript(messages, events, settings, cwd, pending)
  const wasReadOnly = buffer.readOnly
  buffer.readOnly = false
  buffer.setText(rendered.text, false)
  buffer.locals.set(JAGENT_SECTIONS, rendered.sections)
  buffer.point = buffer.text.length
  buffer.readOnly = wasReadOnly
}
