import type { BufferModel } from "../../jemacs-opentui/src/kernel/buffer"
import type { FaceName, TextSpan } from "../../jemacs-opentui/src/modes/mode"
import type { GeminiJsonError, GeminiJsonResponse, GeminiTokenStats, GeminiTurn } from "./types"

export const GEMINI_SECTIONS = "gemini-sections"
export const GEMINI_HISTORY = "gemini-history"
export const GEMINI_PENDING = "gemini-pending"

export type GeminiSectionKind =
  | "banner"
  | "user-header"
  | "user-body"
  | "response-header"
  | "response-body"
  | "stats"
  | "error"
  | "separator"
  | "code"
  | "pending"

export type GeminiSection = {
  start: number
  end: number
  kind: GeminiSectionKind
}

const BAR = "─"
const WIDTH = 72

function padLine(label: string, right = ""): string {
  const inner = right ? `${label}  ${right}` : label
  const fill = Math.max(1, WIDTH - inner.length - 4)
  return `╭─ ${inner} ${BAR.repeat(fill)}╮\n`
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  } catch {
    return iso
  }
}

function formatTokens(tokens?: GeminiTokenStats): string {
  if (!tokens) return "no token stats"
  const parts: string[] = []
  if (tokens.total != null) parts.push(`${tokens.total.toLocaleString()} total`)
  if (tokens.prompt != null) parts.push(`${tokens.prompt.toLocaleString()} in`)
  if (tokens.candidates != null) parts.push(`${tokens.candidates.toLocaleString()} out`)
  if (tokens.thoughts) parts.push(`${tokens.thoughts.toLocaleString()} thoughts`)
  if (tokens.cached) parts.push(`${tokens.cached.toLocaleString()} cached`)
  return parts.join(" · ")
}

function pickPrimaryModel(stats: GeminiJsonResponse["stats"]): { name: string; latencyMs?: number; tokens?: GeminiTokenStats } | null {
  const models = stats?.models
  if (!models) return null
  let best: { name: string; latencyMs?: number; tokens?: GeminiTokenStats } | null = null
  for (const [name, data] of Object.entries(models)) {
    const latency = data.api?.totalLatencyMs ?? 0
    if (!best || latency >= (best.latencyMs ?? 0)) {
      best = { name, latencyMs: data.api?.totalLatencyMs, tokens: data.tokens }
    }
  }
  return best
}

function summarizeStats(json: GeminiJsonResponse): { model?: string; latencyMs?: number; tokens?: GeminiTokenStats; toolCalls?: number } {
  const primary = pickPrimaryModel(json.stats)
  return {
    model: primary?.name,
    latencyMs: primary?.latencyMs,
    tokens: primary?.tokens,
    toolCalls: json.stats?.tools?.totalCalls,
  }
}

export function turnFromJson(prompt: string, json: GeminiJsonResponse, at = new Date().toISOString()): GeminiTurn {
  const summary = summarizeStats(json)
  return {
    role: "assistant",
    prompt,
    response: json.response ?? undefined,
    error: json.error ?? undefined,
    sessionId: json.session_id,
    model: summary.model,
    latencyMs: summary.latencyMs,
    tokens: summary.tokens,
    toolCalls: summary.toolCalls,
    at,
  }
}

function renderUserTurn(prompt: string, at: string): { text: string; sections: GeminiSection[] } {
  const sections: GeminiSection[] = []
  let text = ""
  const push = (chunk: string, kind: GeminiSectionKind) => {
    const start = text.length
    text += chunk
    sections.push({ start, end: text.length, kind })
  }

  push(padLine("◆ You", formatTime(at)), "user-header")
  push("\n", "separator")
  push(prompt.trimEnd() + "\n", "user-body")
  push("\n", "separator")
  return { text, sections }
}

function renderAssistantTurn(turn: GeminiTurn): { text: string; sections: GeminiSection[] } {
  const sections: GeminiSection[] = []
  let text = ""
  const push = (chunk: string, kind: GeminiSectionKind) => {
    const start = text.length
    text += chunk
    sections.push({ start, end: text.length, kind })
  }

  const headerRight = [
    turn.model,
    turn.latencyMs != null ? `${(turn.latencyMs / 1000).toFixed(1)}s` : null,
    formatTime(turn.at),
  ].filter(Boolean).join(" · ")

  push(padLine("◇ Gemini", headerRight), "response-header")
  push("\n", "separator")

  if (turn.error) {
    const msg = turn.error.message ?? turn.error.type ?? "Unknown error"
    push(msg + "\n", "error")
  } else if (turn.response) {
    const bodyStart = text.length
    push(turn.response.trimEnd() + "\n", "response-body")
    addCodeSpans(sections, text, bodyStart, text.length)
  } else {
    push("(no response)\n", "error")
  }

  push("\n", "separator")
  const statsParts: string[] = []
  statsParts.push(`tokens ${formatTokens(turn.tokens)}`)
  if (turn.latencyMs != null) statsParts.push(`${turn.latencyMs.toLocaleString()} ms`)
  if (turn.toolCalls != null) statsParts.push(`tools ${turn.toolCalls} call${turn.toolCalls === 1 ? "" : "s"}`)
  if (turn.sessionId) statsParts.push(`session ${turn.sessionId.slice(0, 8)}…`)
  push(`  ${statsParts.join("  ·  ")}\n`, "stats")
  push("\n", "separator")
  return { text, sections }
}

function addCodeSpans(sections: GeminiSection[], fullText: string, start: number, end: number): void {
  const slice = fullText.slice(start, end)
  const fence = /```[\w-]*\n[\s\S]*?```/g
  let match: RegExpExecArray | null
  while ((match = fence.exec(slice))) {
    sections.push({
      start: start + match.index,
      end: start + match.index + match[0].length,
      kind: "code",
    })
  }
}

export function renderPendingBanner(): { text: string; sections: GeminiSection[] } {
  const text = padLine("◌ Gemini", "thinking…") + "\n"
  return {
    text,
    sections: [{ start: 0, end: text.length, kind: "pending" }],
  }
}

export function renderWelcomeBanner(): { text: string; sections: GeminiSection[] } {
  const text =
    padLine("✦ Gemini", "jemacs") +
    "\n" +
    "Ask Gemini from anywhere:\n" +
    "  M-x gemini-ask          — prompt in the minibuffer\n" +
    "  M-x gemini-ask-buffer   — include the current buffer\n" +
    "  M-x gemini-ask-region   — include the active region\n" +
    "  r / RET in this buffer  — follow-up on the conversation\n" +
    "  g                       — refresh (re-run last prompt)\n" +
    "  q                       — bury buffer\n" +
    "\n"
  return {
    text,
    sections: [
      { start: 0, end: text.indexOf("\n\n") + 1, kind: "banner" },
      { start: text.indexOf("Ask Gemini"), end: text.length, kind: "user-body" },
    ],
  }
}

export function renderTurnPair(prompt: string, turn: GeminiTurn, askedAt = turn.at): { text: string; sections: GeminiSection[] } {
  const user = renderUserTurn(prompt, askedAt)
  const assistant = renderAssistantTurn(turn)
  const offset = user.text.length
  const sections = [
    ...user.sections,
    ...assistant.sections.map(s => ({ ...s, start: s.start + offset, end: s.end + offset })),
  ]
  return { text: user.text + assistant.text, sections }
}

export function appendTurns(
  buffer: BufferModel,
  existingSections: GeminiSection[],
  chunk: { text: string; sections: GeminiSection[] },
): GeminiSection[] {
  const offset = buffer.text.length
  buffer.append(chunk.text)
  return [
    ...existingSections,
    ...chunk.sections.map(s => ({ ...s, start: s.start + offset, end: s.end + offset })),
  ]
}

const FACE_BY_KIND: Record<GeminiSectionKind, FaceName> = {
  banner: "title" as FaceName,
  "user-header": "gemini-user-header" as FaceName,
  "user-body": "gemini-user-body" as FaceName,
  "response-header": "gemini-response-header" as FaceName,
  "response-body": "default",
  stats: "comment",
  error: "error",
  separator: "constant",
  code: "builtin",
  pending: "gemini-pending" as FaceName,
}

export function geminiFontLock(buffer: BufferModel): TextSpan[] {
  const sections = (buffer.locals.get(GEMINI_SECTIONS) as GeminiSection[] | undefined) ?? []
  const spans: TextSpan[] = []
  for (const section of sections) {
    if (section.end <= section.start) continue
    spans.push({
      start: section.start,
      end: Math.min(section.end, buffer.text.length),
      face: FACE_BY_KIND[section.kind],
    })
  }
  highlightInlineMarkdown(buffer.text, spans)
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

function inSpan(spans: TextSpan[], start: number, end: number): boolean {
  return spans.some(s => s.start <= start && s.end >= end)
}

function highlightInlineMarkdown(text: string, spans: TextSpan[]): void {
  const inlineCode = /`[^`\n]+`/g
  let match: RegExpExecArray | null
  while ((match = inlineCode.exec(text))) {
    const start = match.index
    const end = start + match[0].length
    if (!inSpan(spans, start, end)) spans.push({ start, end, face: "builtin" })
  }
  const bold = /\*\*[^*\n]+\*\*/g
  while ((match = bold.exec(text))) {
    const start = match.index
    const end = start + match[0].length
    if (!inSpan(spans, start, end)) spans.push({ start, end, face: "keyword" })
  }
}

export function formatError(error: GeminiJsonError | string): string {
  if (typeof error === "string") return error
  return error.message ?? error.type ?? "Gemini error"
}
