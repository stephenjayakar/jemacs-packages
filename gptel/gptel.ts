import { readFileSync, statSync } from "node:fs"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import type { BufferModel } from "../../jemacs-opentui/src/kernel/buffer"
import type { Editor, TransientDefinition } from "../../jemacs-opentui/src/kernel/editor"

type GptelDeps = {
  Keymap: typeof import("../../jemacs-opentui/src/kernel/keymap").Keymap
  defineMode: typeof import("../../jemacs-opentui/src/modes/mode").defineMode
  defineMinorMode: typeof import("../../jemacs-opentui/src/modes/minor-mode").defineMinorMode
  defcustom: typeof import("../../jemacs-opentui/src/runtime/custom").defcustom
  getCustom: typeof import("../../jemacs-opentui/src/runtime/custom").getCustom
  setCustom: typeof import("../../jemacs-opentui/src/runtime/custom").setCustom
  defface: typeof import("../../jemacs-opentui/src/runtime/faces").defface
  killNew: typeof import("../../jemacs-opentui/src/runtime/kill-ring").killNew
}

export type GptelMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  name?: string
  toolCallId?: string
  toolCalls?: GptelToolCall[]
  media?: GptelMediaPart[]
}

export type GptelBackendKind =
  | "openai"
  | "openai-responses"
  | "anthropic"
  | "gemini"
  | "ollama"
  | "kagi"
  | "bedrock"
  | "mock"

export type GptelBackend = {
  name: string
  kind: GptelBackendKind
  host?: string
  endpoint?: string
  protocol?: "https" | "http"
  key?: string | (() => string)
  keyEnv?: string
  models: string[]
  defaultModel?: string
  stream?: boolean
  headers?: Record<string, string>
  requestParams?: Record<string, unknown>
  apiKeyHeader?: string
  authorizationPrefix?: string
  modelRegion?: "global" | "apac" | "eu" | "us"
}

export type GptelContextItem =
  | { type: "buffer"; name: string; bufferId: string; text: string }
  | { type: "region"; name: string; bufferId: string; start: number; end: number; text: string }
  | { type: "file"; path: string; text: string; binary?: boolean; mime?: string }
  | { type: "directory"; path: string; files: Array<{ path: string; text: string }> }
  | { type: "text"; name: string; text: string }

export type GptelTool = {
  name: string
  description: string
  parameters?: unknown
  confirm?: boolean
  include?: boolean
  function: (args: unknown, ctx: { editor: Editor; buffer: BufferModel }) => unknown | Promise<unknown>
}

export type GptelToolCall = {
  id: string
  name: string
  arguments: unknown
}

export type GptelTokenUsage = {
  input?: number
  output?: number
  cached?: number
  cache?: number
}

export type GptelMediaPart = {
  path: string
  mime: string
  base64: string
}

export type GptelPreset = {
  name: string
  description?: string
  backend?: string
  model?: string
  system?: string
  temperature?: number
  schema?: unknown
  tools?: string[]
}

export type GptelRequestContext = {
  editor: Editor
  buffer: BufferModel
  backend: GptelBackend
  model: string
}

export type GptelPromptTransform = (prompt: string, ctx: GptelRequestContext) => string | Promise<string>
export type GptelResponseFilter = (response: string, ctx: GptelRequestContext) => string | Promise<string>
export type GptelPostResponseFunction = (start: number, end: number, ctx: GptelRequestContext) => void | Promise<void>

type GptelState = {
  backends: Map<string, GptelBackend>
  tools: Map<string, GptelTool>
  presets: Map<string, GptelPreset>
  promptTransforms: GptelPromptTransform[]
  responseFilters: GptelResponseFilter[]
  postResponseFunctions: GptelPostResponseFunction[]
  context: GptelContextItem[]
  activeRequests: Map<string, AbortController>
  tokenUsage: GptelTokenUsage
  lastRequest?: {
    bufferId: string
    prompt: string
    messages: GptelMessage[]
    insertionStart: number
    responseStart: number
    responseEnd: number
    insertionEnd: number
    backend: string
    model: string
    usage?: GptelTokenUsage
    variants: string[]
    variantIndex: number
  }
  lastRewrite?: {
    bufferId: string
    start: number
    end: number
    original: string
    replacement: string
    instruction: string
  }
}

type RequestResult = {
  text: string
  raw?: unknown
  usage?: GptelTokenUsage
  toolCalls?: GptelToolCall[]
}

const STATE_KEY = "gptel-state"
const GPTEL_MODE = "gptel-mode"
const GPTEL_CHAT_MODE = "gptel-chat"
const GPTEL_CONTEXT_MODE = "gptel-context"
const GPTEL_BUFFER_PREFIX = "*ChatGPT*"
const CONTEXT_SECTIONS = "gptel-context-sections"
const CONTEXT_FLAGGED = "gptel-context-flagged"

type GptelContextSection = {
  index: number
  start: number
  end: number
}

export type GptelChatMarkers = {
  promptPrefix: string
  responsePrefix: string
  separator: string
}

function jemacsHome(): string {
  return process.env.JEMACS_HOME ?? join(homedir(), "programming", "jemacs", "jemacs-opentui")
}

async function loadDeps(): Promise<GptelDeps> {
  const home = jemacsHome()
  const [keymap, mode, minorMode, custom, faces, killRing] = await Promise.all([
    import(join(home, "src/kernel/keymap.ts")),
    import(join(home, "src/modes/mode.ts")),
    import(join(home, "src/modes/minor-mode.ts")),
    import(join(home, "src/runtime/custom.ts")),
    import(join(home, "src/runtime/faces.ts")),
    import(join(home, "src/runtime/kill-ring.ts")),
  ])
  return {
    Keymap: keymap.Keymap,
    defineMode: mode.defineMode,
    defineMinorMode: minorMode.defineMinorMode,
    defcustom: custom.defcustom,
    getCustom: custom.getCustom,
    setCustom: custom.setCustom,
    defface: faces.defface,
    killNew: killRing.killNew,
  }
}

function readSecret(path: string): string {
  try {
    const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path
    return readFileSync(expanded, "utf8").trim()
  } catch {
    return ""
  }
}

function emacsCachePath(...parts: string[]): string {
  return join(process.env.HOME || homedir(), ".emacs.d", ".cache", ...parts)
}

function tokenFromFile(path: string): string {
  const raw = readSecret(path)
  if (!raw) return ""
  try {
    const json = JSON.parse(raw)
    return String(json.token ?? json.access_token ?? json.id_token ?? raw).trim()
  } catch {
    return raw
  }
}

async function writeTokenFile(path: string, token: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ token, updatedAt: new Date().toISOString() }, null, 2), "utf8")
}

function apiKey(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]
    if (value) return value
  }
  return ""
}

export function defaultBackends(): GptelBackend[] {
  return [
    {
      name: "ChatGPT",
      kind: "openai",
      host: "api.openai.com",
      endpoint: "/v1/chat/completions",
      keyEnv: "OPENAI_API_KEY",
      key: () => apiKey("OPENAI_API_KEY") || readSecret("~/.emacs.d/secret/openai-key"),
      models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "o4-mini", "o3"],
      defaultModel: "gpt-4.1-mini",
      stream: true,
    },
    {
      name: "OpenAI Responses",
      kind: "openai-responses",
      host: "api.openai.com",
      endpoint: "/v1/responses",
      keyEnv: "OPENAI_API_KEY",
      key: () => apiKey("OPENAI_API_KEY") || readSecret("~/.emacs.d/secret/openai-key"),
      models: ["gpt-4.1", "gpt-4.1-mini", "o4-mini", "o3"],
      defaultModel: "gpt-4.1-mini",
      stream: true,
    },
    {
      name: "Claude",
      kind: "anthropic",
      host: "api.anthropic.com",
      endpoint: "/v1/messages",
      keyEnv: "ANTHROPIC_API_KEY",
      key: () => apiKey("ANTHROPIC_API_KEY") || readSecret("~/.emacs.d/secret/ant-key"),
      models: ["claude-sonnet-4-5-20250929", "claude-opus-4-1-20250805", "claude-3-5-haiku-latest"],
      defaultModel: "claude-sonnet-4-5-20250929",
      stream: true,
    },
    {
      name: "Gemini",
      kind: "gemini",
      host: "generativelanguage.googleapis.com",
      endpoint: "/v1beta/models/{model}:streamGenerateContent",
      keyEnv: "GEMINI_API_KEY",
      models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
      defaultModel: "gemini-2.5-flash",
      stream: true,
    },
    {
      name: "Ollama",
      kind: "ollama",
      protocol: "http",
      host: "localhost:11434",
      endpoint: "/api/chat",
      models: ["llama3.2", "qwen2.5-coder", "mistral"],
      defaultModel: "llama3.2",
      stream: true,
    },
    {
      name: "Mock",
      kind: "mock",
      models: ["mock"],
      defaultModel: "mock",
      stream: true,
    },
  ]
}

function state(editor: Editor): GptelState {
  const existing = editor.locals.get(STATE_KEY) as GptelState | undefined
  if (existing) return existing
  const next: GptelState = {
    backends: new Map(defaultBackends().map(backend => [backend.name, backend])),
    tools: new Map(),
    presets: new Map(),
    promptTransforms: [],
    responseFilters: [],
    postResponseFunctions: [],
    context: [],
    activeRequests: new Map(),
    tokenUsage: {},
  }
  editor.locals.set(STATE_KEY, next)
  return next
}

function backendByName(editor: Editor, deps: GptelDeps, name?: string): GptelBackend {
  const st = state(editor)
  const desired = name || deps.getCustom<string>("gptel-backend") || "ChatGPT"
  const fallback = st.backends.values().next().value as GptelBackend | undefined
  const backend = st.backends.get(desired) ?? fallback
  if (!backend) throw new Error("gptel: no backends configured")
  return backend
}

function currentModel(editor: Editor, deps: GptelDeps, backend?: GptelBackend): string {
  const custom = deps.getCustom<string>("gptel-model")
  if (custom) return custom
  const active = backend ?? backendByName(editor, deps)
  return active.defaultModel ?? active.models[0] ?? "model"
}

function backendKey(backend: GptelBackend): string {
  if (typeof backend.key === "function") return backend.key()
  if (backend.key) return backend.key
  if (backend.keyEnv) return process.env[backend.keyEnv] ?? ""
  return ""
}

const BEDROCK_MODEL_IDS: Record<string, string> = {
  "claude-sonnet-4-5-20250929": "anthropic.claude-sonnet-4-5-20250929-v1:0",
  "claude-opus-4-1-20250805": "anthropic.claude-opus-4-1-20250805-v1:0",
  "claude-3-7-sonnet-20250219": "anthropic.claude-3-7-sonnet-20250219-v1:0",
  "claude-3-5-sonnet-20241022": "anthropic.claude-3-5-sonnet-20241022-v2:0",
  "claude-3-5-haiku-20241022": "anthropic.claude-3-5-haiku-20241022-v1:0",
  "nova-2-lite-v1": "amazon.nova-2-lite-v1:0",
  "mistral-7b": "mistral.mistral-7b-instruct-v0:2",
  "llama-3-3-70b": "meta.llama3-3-70b-instruct-v1:0",
}

function bedrockModelId(backend: GptelBackend, model: string): string {
  const mapped = BEDROCK_MODEL_IDS[model] ?? model
  return backend.modelRegion ? `${backend.modelRegion}.${mapped}` : mapped
}

function backendUrl(backend: GptelBackend, model: string): string {
  const protocol = backend.protocol ?? "https"
  const host = backend.host ?? "api.openai.com"
  const endpointModel = backend.kind === "bedrock" ? bedrockModelId(backend, model) : model
  const kagiAction = model === "fastgpt" ? "fastgpt" : "summarize"
  const endpoint = (backend.endpoint ?? "/v1/chat/completions")
    .replace("{model}", encodeURIComponent(endpointModel))
    .replace("{kagiAction}", kagiAction)
  if (/^https?:\/\//.test(endpoint)) return endpoint
  return `${protocol}://${host}${endpoint}`
}

export function mimeTypeForPath(path: string): string | null {
  const lower = path.toLowerCase()
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".gif")) return "image/gif"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".heic")) return "image/heic"
  if (lower.endsWith(".heif")) return "image/heif"
  if (lower.endsWith(".pdf")) return "application/pdf"
  if (lower.endsWith(".txt")) return "text/plain"
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown"
  if (lower.endsWith(".json")) return "application/json"
  if (lower.endsWith(".csv")) return "text/csv"
  return null
}

function isTextMime(mime: string | undefined): boolean {
  return Boolean(mime?.startsWith("text/") || mime === "application/json")
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/")
}

function base64File(path: string): string | null {
  try { return readFileSync(path).toString("base64") } catch { return null }
}

export function mediaPartsFromContext(items: readonly GptelContextItem[]): GptelMediaPart[] {
  const media: GptelMediaPart[] = []
  for (const item of items) {
    if (item.type !== "file" || !item.mime || isTextMime(item.mime)) continue
    const base64 = base64File(item.path)
    if (base64) media.push({ path: item.path, mime: item.mime, base64 })
  }
  return media
}

function regionBounds(buffer: BufferModel): [number, number] | null {
  if (buffer.mark == null || buffer.mark === buffer.point) return null
  return [Math.min(buffer.mark, buffer.point), Math.max(buffer.mark, buffer.point)]
}

function activeRegionText(buffer: BufferModel): string | null {
  const bounds = regionBounds(buffer)
  if (!bounds) return null
  return buffer.text.slice(bounds[0], bounds[1])
}

function defaultChatMarkers(): GptelChatMarkers {
  return { promptPrefix: "User:\n", responsePrefix: "Assistant:\n", separator: "\n\n" }
}

function chatMarkers(deps: GptelDeps): GptelChatMarkers {
  const defaults = defaultChatMarkers()
  return {
    promptPrefix: deps.getCustom<string>("gptel-prompt-prefix") ?? defaults.promptPrefix,
    responsePrefix: deps.getCustom<string>("gptel-response-prefix") ?? defaults.responsePrefix,
    separator: deps.getCustom<string>("gptel-response-separator") ?? defaults.separator,
  }
}

function markerText(markers: GptelChatMarkers, role: "user" | "assistant", atStart = false): string {
  const prefix = role === "user" ? markers.promptPrefix : markers.responsePrefix
  return `${atStart ? "" : markers.separator}${prefix}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function markerAlternatives(markers: GptelChatMarkers): string[] {
  return [
    markerText(markers, "user", true),
    markerText(markers, "user"),
    markerText(markers, "assistant", true),
    markerText(markers, "assistant"),
  ].filter((marker, index, all) => marker.length > 0 && all.indexOf(marker) === index)
}

export function extractPrompt(buffer: BufferModel, markers: GptelChatMarkers = defaultChatMarkers()): { prompt: string; start: number; end: number } {
  const bounds = regionBounds(buffer)
  if (bounds) return { prompt: buffer.text.slice(bounds[0], bounds[1]).trim(), start: bounds[0], end: bounds[1] }
  if (buffer.mode === GPTEL_CHAT_MODE || buffer.minorModes.has(GPTEL_MODE)) {
    const beforePoint = buffer.text.slice(0, buffer.point)
    const user = Math.max(beforePoint.lastIndexOf(markerText(markers, "user", true)), beforePoint.lastIndexOf(markerText(markers, "user")))
    const assistant = Math.max(beforePoint.lastIndexOf(markerText(markers, "assistant", true)), beforePoint.lastIndexOf(markerText(markers, "assistant")))
    const start = user >= 0 && user > assistant
      ? user + (beforePoint.startsWith(markerText(markers, "user", true), user) ? markerText(markers, "user", true).length : markerText(markers, "user").length)
      : 0
    return { prompt: beforePoint.slice(start).trim(), start, end: buffer.point }
  }
  return { prompt: buffer.text.slice(0, buffer.point).trim(), start: 0, end: buffer.point }
}

export function renderContext(items: readonly GptelContextItem[]): string {
  if (items.length === 0) return ""
  const parts = ["Additional context:"]
  for (const item of items) {
    if (item.type === "buffer") parts.push(`\n--- Buffer: ${item.name} ---\n${item.text}`)
    else if (item.type === "region") parts.push(`\n--- Region: ${item.name}:${item.start}-${item.end} ---\n${item.text}`)
    else if (item.type === "file") parts.push(`\n--- File: ${item.path} ---\n${item.binary ? "[binary file omitted]" : item.text}`)
    else if (item.type === "directory") {
      parts.push(`\n--- Directory: ${item.path} ---`)
      for (const file of item.files) parts.push(`\n--- File: ${file.path} ---\n${file.text}`)
    } else parts.push(`\n--- ${item.name} ---\n${item.text}`)
  }
  return parts.join("\n")
}

function contextItemTitle(item: GptelContextItem, index: number): string {
  if (item.type === "buffer") return `${index + 1}. Buffer: ${item.name}`
  if (item.type === "region") return `${index + 1}. Region: ${item.name}:${item.start}-${item.end}`
  if (item.type === "file") return `${index + 1}. File: ${item.path}`
  if (item.type === "directory") return `${index + 1}. Directory: ${item.path} (${item.files.length} files)`
  return `${index + 1}. ${item.name}`
}

function contextItemPreview(item: GptelContextItem): string {
  const text = item.type === "directory"
    ? item.files.map(file => `${file.path}\n${file.text}`).join("\n\n")
    : item.type === "file" && item.binary
      ? "[binary file omitted]"
      : item.text
  const lines = text.split("\n").slice(0, 12)
  const preview = lines.join("\n")
  return text.split("\n").length > lines.length ? `${preview}\n...` : preview
}

export function renderContextBuffer(items: readonly GptelContextItem[], flagged: ReadonlySet<number> = new Set()): {
  text: string
  sections: GptelContextSection[]
} {
  const sections: GptelContextSection[] = []
  const chunks = [
    "gptel context",
    "",
    "d: mark/unmark deletion   n/p: next/previous   RET: visit   C-c C-c: apply   C-c C-k: quit",
    "",
  ]
  let offset = chunks.join("\n").length
  if (items.length === 0) {
    chunks.push("No gptel context.")
    return { text: chunks.join("\n"), sections }
  }
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!
    const marker = flagged.has(index) ? "D" : " "
    const body = `[${marker}] ${contextItemTitle(item, index)}\n${contextItemPreview(item)}\n`
    const start = offset
    const end = start + body.length
    sections.push({ index, start, end })
    chunks.push(body)
    offset = end + 1
  }
  return { text: chunks.join("\n"), sections }
}

export function responseRanges(buffer: BufferModel, markers: GptelChatMarkers = defaultChatMarkers()): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const responseMarkers = [markerText(markers, "assistant", true), markerText(markers, "assistant")]
    .filter((marker, index, all) => marker.length > 0 && all.indexOf(marker) === index)
    .map(escapeRegExp)
  if (!responseMarkers.length) return ranges
  const nextMarkers = markerAlternatives(markers).map(escapeRegExp).join("|")
  const regex = new RegExp(`(?:${responseMarkers.join("|")})([\\s\\S]*?)(?=${nextMarkers}|$)`, "g")
  for (const match of buffer.text.matchAll(regex)) {
    const full = match[0] ?? ""
    const body = match[1] ?? ""
    const end = (match.index ?? 0) + full.length
    ranges.push({ start: end - body.length, end })
  }
  return ranges
}

function responseRangeAtPoint(buffer: BufferModel, markers: GptelChatMarkers): { start: number; end: number } | null {
  return responseRanges(buffer, markers).find(range => buffer.point >= range.start && buffer.point <= range.end) ?? null
}

function chatHistory(buffer: BufferModel, markers: GptelChatMarkers = defaultChatMarkers()): GptelMessage[] {
  const messages: GptelMessage[] = []
  const alternatives = markerAlternatives(markers)
  const regex = new RegExp(`(${alternatives.map(escapeRegExp).join("|")})([\\s\\S]*?)(?=${alternatives.map(escapeRegExp).join("|")}|$)`, "g")
  for (const match of buffer.text.matchAll(regex)) {
    const marker = match[1] ?? ""
    const role = marker === markerText(markers, "user", true) || marker === markerText(markers, "user") ? "user" : "assistant"
    const content = (match[2] ?? "").trim()
    if (content) messages.push({ role, content })
  }
  return messages
}

function stripReasoningBlocks(text: string): string {
  return text
    .replace(/```[ \t]*reasoning[^\n]*\n[\s\S]*?```[ \t]*(?:\n{0,2})/g, "")
    .replace(/^#\+begin_reasoning\n[\s\S]*?^#\+end_reasoning[ \t]*(?:\n{0,2})/gmi, "")
    .trim()
}

function lastAssistantResponse(buffer: BufferModel, markers: GptelChatMarkers = defaultChatMarkers()): string | null {
  const messages = chatHistory(buffer, markers).filter(message => message.role === "assistant")
  return messages.at(-1)?.content ?? null
}

async function applyPromptTransforms(editor: Editor, buffer: BufferModel, backend: GptelBackend, model: string, prompt: string): Promise<string> {
  let transformed = prompt
  const ctx = { editor, buffer, backend, model }
  for (const transform of state(editor).promptTransforms) transformed = await transform(transformed, ctx)
  return transformed
}

async function applyResponseFilters(editor: Editor, buffer: BufferModel, backend: GptelBackend, model: string, response: string): Promise<string> {
  let filtered = response
  const ctx = { editor, buffer, backend, model }
  for (const filter of state(editor).responseFilters) filtered = await filter(filtered, ctx)
  return filtered
}

export function convertMarkdownToOrg(markdown: string): string {
  const lines = markdown.split("\n")
  const converted: string[] = []
  let inFence = false
  for (const rawLine of lines) {
    const fence = rawLine.match(/^(\s*)```+\s*([^`]*)\s*$/)
    if (fence) {
      const indent = fence[1] ?? ""
      const info = (fence[2] ?? "").trim()
      if (inFence) {
        converted.push(`${indent}#+end_src`)
        inFence = false
      } else {
        const language = info.split(/\s+/)[0] ?? ""
        converted.push(`${indent}#+begin_src${language ? ` ${language}` : ""}`)
        inFence = true
      }
      continue
    }
    if (inFence) {
      converted.push(rawLine)
      continue
    }
    let line = rawLine
      .replace(/^(\s*)\*[ \t]+/, "$1- ")
      .replace(/^(\s{0,3})(#{1,6})[ \t]+(.+)$/, (_match, indent: string, hashes: string, title: string) => `${indent}${"*".repeat(hashes.length)} ${title}`)
      .replace(/`([^`\n]+)`/g, "=$1=")
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1/$2/")
      .replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, "$1/$2/")
    converted.push(line)
  }
  if (inFence) converted.push("#+end_src")
  return converted.join("\n")
}

function shouldConvertResponseToOrg(deps: GptelDeps, buffer: BufferModel): boolean {
  return buffer.mode === "org-mode" && deps.getCustom<boolean>("gptel-org-convert-response") !== false
}

async function runPostResponseFunctions(editor: Editor, buffer: BufferModel, backend: GptelBackend, model: string, start: number, end: number): Promise<void> {
  const ctx = { editor, buffer, backend, model }
  for (const fn of state(editor).postResponseFunctions) await fn(start, end, ctx)
  await editor.runHook("gptel-post-response-functions", buffer)
}

async function buildMessages(editor: Editor, deps: GptelDeps, buffer: BufferModel, prompt: string, backend: GptelBackend, model: string, markers: GptelChatMarkers): Promise<GptelMessage[]> {
  const messages: GptelMessage[] = []
  const system = deps.getCustom<string>("gptel-system-message") || "You are a helpful assistant."
  if (system) messages.push({ role: "system", content: system })
  const st = state(editor)
  const context = renderContext(st.context)
  const media = mediaPartsFromContext(st.context)
  const history = (buffer.mode === GPTEL_CHAT_MODE || buffer.minorModes.has(GPTEL_MODE)) ? chatHistory(buffer, markers) : []
  const includeReasoning = deps.getCustom<boolean | string>("gptel-include-reasoning")
  messages.push(...history.slice(0, -1).map(message =>
    message.role === "assistant" && includeReasoning === "ignore"
      ? { ...message, content: stripReasoningBlocks(message.content) }
      : message
  ))
  const promptWithContext = context ? `${context}\n\nUser request:\n${prompt}` : prompt
  messages.push({ role: "user", content: await applyPromptTransforms(editor, buffer, backend, model, promptWithContext), media })
  return messages
}

function appendWritable(buffer: BufferModel, text: string): void {
  const wasReadOnly = buffer.readOnly
  buffer.readOnly = false
  buffer.point = buffer.text.length
  buffer.insert(text)
  buffer.readOnly = wasReadOnly
}

function replaceWritable(buffer: BufferModel, start: number, end: number, text: string): void {
  const wasReadOnly = buffer.readOnly
  buffer.readOnly = false
  buffer.replaceRange(start, end, text)
  buffer.readOnly = wasReadOnly
}

function selectedTools(editor: Editor, deps: GptelDeps): GptelTool[] {
  if (deps.getCustom<boolean | string>("gptel-use-tools") === false) return []
  const st = state(editor)
  const names = deps.getCustom<string>("gptel-tools")
    ?.split(/[, ]+/)
    .map(name => name.trim())
    .filter(Boolean)
  if (!names?.length) return []
  return names.map(name => st.tools.get(name)).filter((tool): tool is GptelTool => Boolean(tool))
}

function includeToolResult(deps: GptelDeps, tool: GptelTool | undefined): boolean {
  const setting = deps.getCustom<boolean | string>("gptel-include-tool-results") ?? "auto"
  if (setting === true || setting === "true") return true
  if (setting === false || setting === "false") return false
  return tool?.include === true
}

function openAiTool(tool: GptelTool): unknown {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  }
}

function anthropicTool(tool: GptelTool): unknown {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters ?? { type: "object", properties: {} },
  }
}

function bedrockTool(tool: GptelTool): unknown {
  return {
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.parameters ?? { type: "object", properties: {} } },
    },
  }
}

function openAiContent(message: GptelMessage): unknown {
  if (!message.media?.length) return message.content
  const parts: unknown[] = []
  if (message.content) parts.push({ type: "text", text: message.content })
  for (const media of message.media) {
    if (!isImageMime(media.mime)) continue
    parts.push({
      type: "image_url",
      image_url: { url: `data:${media.mime};base64,${media.base64}` },
    })
  }
  return parts
}

function openAiResponsesContent(message: GptelMessage): unknown {
  if (!message.media?.length) return message.content
  const parts: unknown[] = []
  if (message.content) parts.push({ type: "input_text", text: message.content })
  for (const media of message.media) {
    if (!isImageMime(media.mime)) continue
    parts.push({
      type: "input_image",
      image_url: `data:${media.mime};base64,${media.base64}`,
    })
  }
  return parts
}

function openAiMessages(messages: GptelMessage[], responsesApi = false): unknown[] {
  return messages.map(message => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        name: message.name,
        content: message.content,
      }
    }
    const base: Record<string, unknown> = {
      role: message.role,
      content: responsesApi ? openAiResponsesContent(message) : openAiContent(message),
    }
    if (message.toolCalls?.length) {
      base.tool_calls = message.toolCalls.map(call => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
      }))
    }
    return base
  })
}

function anthropicMessages(messages: GptelMessage[]): unknown[] {
  return messages.filter(m => m.role !== "system").map(message => {
    if (message.role === "tool") {
      return {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
        }],
      }
    }
    if (message.toolCalls?.length) {
      const content: unknown[] = []
      if (message.content) content.push({ type: "text", text: message.content })
      for (const call of message.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments ?? {} })
      }
      return { role: "assistant", content }
    }
    if (message.media?.length) {
      const content: unknown[] = []
      if (message.content) content.push({ type: "text", text: message.content })
      for (const media of message.media) {
        if (isImageMime(media.mime)) {
          content.push({
            type: "image",
            source: { type: "base64", media_type: media.mime, data: media.base64 },
          })
        } else if (media.mime === "application/pdf") {
          content.push({
            type: "document",
            source: { type: "base64", media_type: media.mime, data: media.base64 },
          })
        }
      }
      return { role: message.role === "assistant" ? "assistant" : "user", content }
    }
    return { role: message.role === "assistant" ? "assistant" : "user", content: message.content }
  })
}

function geminiParts(message: GptelMessage): unknown[] {
  const parts: unknown[] = []
  if (message.content) parts.push({ text: message.content })
  for (const media of message.media ?? []) {
    parts.push({
      inline_data: {
        mime_type: media.mime,
        data: media.base64,
      },
    })
  }
  return parts.length ? parts : [{ text: "" }]
}

function ollamaMessages(messages: GptelMessage[]): unknown[] {
  return messages.map(message => {
    const images = message.media?.filter(media => isImageMime(media.mime)).map(media => media.base64) ?? []
    return {
      role: message.role,
      content: message.content,
      ...(images.length ? { images } : {}),
    }
  })
}

function bedrockContent(message: GptelMessage): unknown[] {
  if (message.role === "tool") {
    return [{
      toolResult: {
        toolUseId: message.toolCallId,
        status: message.content.startsWith("Tool error:") ? "error" : "success",
        content: [{ text: message.content }],
      },
    }]
  }
  if (message.toolCalls?.length) {
    const content: unknown[] = []
    if (message.content) content.push({ text: message.content })
    for (const call of message.toolCalls) {
      content.push({ toolUse: { toolUseId: call.id, name: call.name, input: call.arguments ?? {} } })
    }
    return content
  }
  const content: unknown[] = []
  if (message.content) content.push({ text: message.content })
  for (const media of message.media ?? []) {
    if (isImageMime(media.mime)) {
      const format = media.mime.replace(/^image\//, "").replace("jpg", "jpeg")
      content.push({ image: { format, source: { bytes: media.base64 } } })
    } else if (media.mime === "application/pdf") {
      content.push({ document: { format: "pdf", name: media.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "document", source: { bytes: media.base64 } } })
    }
  }
  return content.length ? content : [{ text: "" }]
}

function bedrockMessages(messages: GptelMessage[]): unknown[] {
  return messages.filter(message => message.role !== "system").map(message => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: bedrockContent(message),
  }))
}

export function providerMessagesForBackend(backend: GptelBackend, messages: GptelMessage[]): unknown[] {
  if (backend.kind === "anthropic") return anthropicMessages(messages)
  if (backend.kind === "gemini") {
    return messages.filter(m => m.role !== "system").map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: geminiParts(m),
    }))
  }
  if (backend.kind === "ollama") return ollamaMessages(messages)
  if (backend.kind === "bedrock") return bedrockMessages(messages)
  return openAiMessages(messages, backend.kind === "openai-responses")
}

function requestParams(backend: GptelBackend): Record<string, unknown> {
  return backend.requestParams ?? {}
}

function schemaType(type: string): string {
  const allowed = ["number", "string", "integer", "boolean", "null"]
  return allowed.find(candidate => candidate.startsWith(type)) ?? type
}

function shorthandSchema(value: string): Record<string, unknown> {
  let source = value.trim()
  let wrapArray = false
  if (source.startsWith("[") && source.endsWith("]")) {
    wrapArray = true
    source = source.slice(1, -1).trim()
  }
  const properties: Record<string, unknown> = {}
  if (!source.includes("\n")) {
    for (const part of source.split(",")) {
      const [name, type = "string"] = part.trim().split(/\s+/)
      if (name) properties[name] = { type: schemaType(type) }
    }
  } else {
    for (const line of source.split(/\n+/)) {
      const match = line.trim().match(/^([^ :]+)(?:\s+([^ :]+))?:?\s*(.*)$/)
      if (!match) continue
      const [, name, type = "string", description = ""] = match
      properties[name] = { type: schemaType(type), ...(description ? { description: description.trim() } : {}) }
    }
  }
  const object = { type: "object", properties }
  return wrapArray ? { type: "array", items: object } : object
}

function preprocessSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(preprocessSchema)
  if (!schema || typeof schema !== "object") return schema
  const record = schema as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) record[key] = preprocessSchema(value)
  if (record.type === "object" && record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
    const propertyNames = Object.keys(record.properties as Record<string, unknown>)
    record.additionalProperties = false
    record.required = propertyNames
    record.propertyOrdering = propertyNames
  }
  return record
}

export function gptelParseSchema(schema: unknown): Record<string, unknown> | undefined {
  if (schema == null || schema === "") return undefined
  let parsed = schema
  if (typeof schema === "string") {
    const trimmed = schema.trim()
    if (!trimmed) return undefined
    parsed = trimmed.startsWith("{") ? JSON.parse(trimmed) : shorthandSchema(trimmed)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const prepared = preprocessSchema(structuredClone(parsed)) as Record<string, unknown>
  if (prepared.type === "array") {
    return preprocessSchema({
      type: "object",
      properties: { items: prepared },
    }) as Record<string, unknown>
  }
  return prepared
}

function currentSchema(deps: GptelDeps): Record<string, unknown> | undefined {
  return gptelParseSchema(deps.getCustom<unknown>("gptel-schema"))
}

function includeReasoningSetting(deps: GptelDeps): boolean | "ignore" | string {
  const value = deps.getCustom<boolean | string>("gptel-include-reasoning") ?? "ignore"
  if (value === false || value === "false" || value === "nil" || value === "no") return false
  if (value === true || value === "true" || value === "t" || value === "yes") return true
  return value
}

function reasoningBlock(reasoning: string, include: boolean | "ignore" | string): string {
  if (!reasoning || include === false) return ""
  return `\`\`\` reasoning\n${reasoning.trim()}\n\`\`\`\n\n`
}

function schemaName(): string {
  return "gptel_schema"
}

function openAiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return { type: "json_schema", json_schema: { name: schemaName(), schema, strict: true } }
}

function openAiResponsesSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return { type: "json_schema", name: schemaName(), schema, strict: true }
}

function anthropicSchemaTool(schema: Record<string, unknown>): unknown {
  return {
    name: "response_json",
    description: "Record JSON output according to user prompt",
    input_schema: schema,
  }
}

function requestBody(
  backend: GptelBackend,
  model: string,
  messages: GptelMessage[],
  deps: GptelDeps,
  stream: boolean,
  tools: GptelTool[] = [],
): unknown {
  const temperature = deps.getCustom<number>("gptel-temperature")
  const maxTokens = deps.getCustom<number>("gptel-max-tokens")
  const extra = requestParams(backend)
  const schema = currentSchema(deps)
  if (backend.kind === "anthropic") {
    const system = messages.find(m => m.role === "system")?.content
    const backendTools = tools.map(anthropicTool)
    return {
      model,
      max_tokens: maxTokens || 4096,
      temperature: temperature || undefined,
      stream,
      system,
      messages: anthropicMessages(messages),
      tools: schema || backendTools.length ? [...(schema ? [anthropicSchemaTool(schema)] : []), ...backendTools] : undefined,
      tool_choice: schema ? { type: "tool", name: "response_json" } : undefined,
      ...extra,
    }
  }
  if (backend.kind === "gemini") {
    return {
      contents: providerMessagesForBackend(backend, messages),
      systemInstruction: messages.find(m => m.role === "system") ? { parts: [{ text: messages.find(m => m.role === "system")!.content }] } : undefined,
      generationConfig: {
        temperature: temperature || undefined,
        maxOutputTokens: maxTokens || undefined,
        ...(includeReasoningSetting(deps) ? { thinkingConfig: { includeThoughts: true } } : {}),
        ...(schema ? { responseMimeType: "application/json", responseSchema: schema } : {}),
      },
      ...extra,
    }
  }
  if (backend.kind === "ollama") {
    return { model, stream, messages: providerMessagesForBackend(backend, messages), format: schema, ...extra }
  }
  if (backend.kind === "kagi") {
    const prompt = messages.filter(message => message.role === "user").at(-1)?.content ?? ""
    if (model === "fastgpt") return { query: prompt, web_search: true, cache: true, ...extra }
    if (model.startsWith("summarize:")) return { text: prompt, engine: model.slice("summarize:".length), ...extra }
    return { query: prompt, ...extra }
  }
  if (backend.kind === "bedrock") {
    const system = messages.find(message => message.role === "system")?.content
    return {
      messages: providerMessagesForBackend(backend, messages),
      system: system ? [{ text: system }] : undefined,
      inferenceConfig: {
        maxTokens: maxTokens || 4096,
        temperature: temperature || undefined,
      },
      toolConfig: tools.length ? { toolChoice: { auto: {} }, tools: tools.map(bedrockTool) } : undefined,
      ...extra,
    }
  }
  if (backend.kind === "openai-responses") {
    return {
      model,
      stream,
      input: (providerMessagesForBackend(backend, messages) as any[]).map((m: any) => ({ ...m, role: m.role === "system" ? "developer" : m.role })),
      tools: tools.length ? tools.map(openAiTool) : undefined,
      text: schema ? { format: openAiResponsesSchema(schema) } : undefined,
      temperature: temperature || undefined,
      max_output_tokens: maxTokens || undefined,
      ...extra,
    }
  }
  return {
    model,
    stream,
    messages: providerMessagesForBackend(backend, messages),
    tools: tools.length ? tools.map(openAiTool) : undefined,
    tool_choice: tools.length ? "auto" : undefined,
    response_format: schema ? openAiSchema(schema) : undefined,
    temperature: temperature || undefined,
    max_tokens: maxTokens || undefined,
    ...extra,
  }
}

function requestHeaders(backend: GptelBackend): Record<string, string> {
  const key = backendKey(backend)
  const headers: Record<string, string> = { "content-type": "application/json", ...(backend.headers ?? {}) }
  if (backend.kind === "anthropic") {
    if (key) headers["x-api-key"] = key
    headers["anthropic-version"] = "2023-06-01"
    headers["anthropic-beta"] = "tools-2024-04-04"
  } else if (backend.kind === "gemini") {
    if (key) headers["x-goog-api-key"] = key
  } else if (backend.kind === "kagi") {
    if (key) headers.authorization = `${backend.authorizationPrefix ?? "Bot"} ${key}`
  } else if (backend.kind === "bedrock") {
    if (key) headers.authorization = `${backend.authorizationPrefix ?? "Bearer"} ${key}`
  } else if (backend.apiKeyHeader) {
    if (key) headers[backend.apiKeyHeader] = key
  } else if (key) {
    headers.authorization = `${backend.authorizationPrefix ?? "Bearer"} ${key}`
  }
  return headers
}

export function parseSseEvents(chunk: string): string[] {
  const events: string[] = []
  for (const event of chunk.split(/\n\n+/)) {
    const lines = event.split(/\n/).filter(line => line.startsWith("data:"))
    if (lines.length) events.push(lines.map(line => line.slice(5).trimStart()).join("\n"))
  }
  return events
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {}
  try { return JSON.parse(value) } catch { return value }
}

export function toolCallsFromJson(backend: GptelBackend, json: unknown): GptelToolCall[] {
  const data = json as Record<string, any>
  if (backend.kind === "anthropic") {
    return (data.content ?? [])
      .filter((part: any) => part.type === "tool_use")
      .map((part: any) => ({ id: String(part.id), name: String(part.name), arguments: part.input ?? {} }))
  }
  if (backend.kind === "openai-responses") {
    return (data.output ?? [])
      .filter((item: any) => item.type === "function_call")
      .map((item: any) => ({ id: String(item.call_id ?? item.id), name: String(item.name), arguments: parseJsonMaybe(item.arguments) }))
  }
  if (backend.kind === "bedrock") {
    return (data.output?.message?.content ?? [])
      .map((part: any) => part.toolUse)
      .filter(Boolean)
      .map((toolUse: any) => ({ id: String(toolUse.toolUseId), name: String(toolUse.name), arguments: toolUse.input ?? {} }))
  }
  const calls = data.choices?.[0]?.message?.tool_calls ?? []
  return calls.map((call: any) => ({
    id: String(call.id),
    name: String(call.function?.name ?? call.name),
    arguments: parseJsonMaybe(call.function?.arguments ?? call.arguments),
  }))
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function usageFromJson(backend: GptelBackend, json: unknown): GptelTokenUsage | undefined {
  const data = json as Record<string, any>
  const usage = data.usage ?? data.response?.usage
  if (!usage) return undefined
  if (backend.kind === "anthropic") {
    const input = (numberOrUndefined(usage.input_tokens) ?? 0) + (numberOrUndefined(usage.cache_creation_input_tokens) ?? 0)
    const output = numberOrUndefined(usage.output_tokens)
    const cached = numberOrUndefined(usage.cache_read_input_tokens)
    return { input, output, cached, cache: numberOrUndefined(usage.cache_creation_input_tokens) }
  }
  if (backend.kind === "gemini") {
    return {
      input: numberOrUndefined(usage.promptTokenCount),
      output: numberOrUndefined(usage.candidatesTokenCount),
    }
  }
  if (backend.kind === "ollama") {
    return {
      input: numberOrUndefined(data.prompt_eval_count),
      output: numberOrUndefined(data.eval_count),
    }
  }
  if (backend.kind === "bedrock") {
    return {
      input: (numberOrUndefined(usage.inputTokens) ?? 0) + (numberOrUndefined(usage.cacheWriteInputTokens) ?? 0),
      output: numberOrUndefined(usage.outputTokens),
      cached: numberOrUndefined(usage.cacheReadInputTokens),
      cache: numberOrUndefined(usage.cacheWriteInputTokens),
    }
  }
  if (backend.kind === "kagi") {
    const tokens = numberOrUndefined(data.data?.tokens ?? data.tokens)
    return tokens == null ? undefined : { input: tokens, output: tokens }
  }
  const inputTotal = numberOrUndefined(usage.prompt_tokens ?? usage.input_tokens)
  const cached = numberOrUndefined(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens)
  return {
    input: inputTotal == null ? undefined : inputTotal - (cached ?? 0),
    output: numberOrUndefined(usage.completion_tokens ?? usage.output_tokens),
    cached,
  }
}

function addUsage(a: GptelTokenUsage, b: GptelTokenUsage | undefined): GptelTokenUsage {
  if (!b) return a
  return {
    input: (a.input ?? 0) + (b.input ?? 0),
    output: (a.output ?? 0) + (b.output ?? 0),
    cached: (a.cached ?? 0) + (b.cached ?? 0),
    cache: (a.cache ?? 0) + (b.cache ?? 0),
  }
}

function formatUsage(usage: GptelTokenUsage | undefined): string {
  if (!usage) return "(none)"
  const parts: string[] = []
  if (usage.input != null) parts.push(`${usage.input} in`)
  if (usage.cached) parts.push(`${usage.cached} cached`)
  if (usage.cache) parts.push(`${usage.cache} cache`)
  if (usage.output != null) parts.push(`${usage.output} out`)
  return parts.join(", ") || "(none)"
}

function reasoningFromJson(backend: GptelBackend, json: unknown): string {
  const data = json as Record<string, any>
  if (backend.kind === "anthropic") return data.content?.filter((part: any) => part.type === "thinking").map((part: any) => part.thinking ?? "").join("") ?? ""
  if (backend.kind === "gemini") return data.candidates?.flatMap((c: any) => c.content?.parts ?? []).filter((part: any) => part.thought).map((part: any) => part.text ?? "").join("") ?? ""
  if (backend.kind === "ollama") return data.message?.thinking ?? data.thinking ?? ""
  if (backend.kind === "openai-responses") {
    return data.output?.filter((part: any) => part.type === "reasoning")
      .flatMap((part: any) => part.summary ?? part.content ?? [])
      .map((part: any) => typeof part === "string" ? part : part.text ?? "")
      .join("") ?? ""
  }
  const message = data.choices?.[0]?.message
  return message?.reasoning ?? message?.reasoning_content ?? ""
}

function textFromJson(backend: GptelBackend, json: unknown, includeReasoning: boolean | "ignore" | string = false): string {
  const data = json as Record<string, any>
  const reasoning = reasoningBlock(reasoningFromJson(backend, json), includeReasoning)
  if (backend.kind === "anthropic") {
    const text = data.content?.filter((part: any) => part.type !== "tool_use" && part.type !== "thinking").map((part: any) => part.text ?? "").join("") ?? ""
    if (text) return `${reasoning}${text}`
    const structured = data.content?.find((part: any) => part.type === "tool_use" && part.name === "response_json")?.input
    return structured == null ? reasoning : `${reasoning}${JSON.stringify(structured, null, 2)}`
  }
  if (backend.kind === "gemini") {
    const text = data.candidates?.flatMap((c: any) => c.content?.parts ?? []).filter((part: any) => !part.thought).map((p: any) => p.text ?? "").join("") ?? ""
    return `${reasoning}${text}`
  }
  if (backend.kind === "ollama") return `${reasoning}${data.message?.content ?? data.response ?? ""}`
  if (backend.kind === "kagi") {
    const output = data.data?.output ?? data.output ?? ""
    const references = data.data?.references ?? data.references
    if (!Array.isArray(references) || references.length === 0) return `${reasoning}${output}`
    const refs = references.map((ref: any, index: number) => {
      const title = ref.title ?? ref.url ?? `Reference ${index + 1}`
      const url = ref.url ? ` (${ref.url})` : ""
      const snippet = ref.snippet ? `: ${String(ref.snippet).replace(/<\/?b>/g, "*")}` : ""
      return `[${index + 1}] ${title}${url}${snippet}`
    }).join("\n")
    return `${reasoning}${output}\n\n${refs}`
  }
  if (backend.kind === "bedrock") {
    return `${reasoning}${data.output?.message?.content?.map((part: any) => part.text ?? "").join("") ?? ""}`
  }
  if (backend.kind === "openai-responses") {
    return `${reasoning}${data.output_text ?? data.output?.filter((o: any) => o.type !== "function_call" && o.type !== "reasoning").flatMap((o: any) => o.content ?? []).map((c: any) => c.text ?? "").join("") ?? ""}`
  }
  return `${reasoning}${data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? ""}`
}

function textFromStreamEvent(backend: GptelBackend, data: string, includeReasoning: boolean | "ignore" | string = false): string {
  if (!data || data === "[DONE]") return ""
  let json: any
  try { json = JSON.parse(data) } catch { return "" }
  if (backend.kind === "anthropic") {
    const thinking = json.delta?.thinking ?? ""
    if (thinking) return reasoningBlock(thinking, includeReasoning)
    if (json.type === "content_block_delta") return json.delta?.text ?? ""
    if (json.type === "message_delta") return ""
  }
  if (backend.kind === "gemini") {
    const parts = json.candidates?.flatMap((c: any) => c.content?.parts ?? []) ?? []
    const thought = parts.filter((part: any) => part.thought).map((part: any) => part.text ?? "").join("")
    const text = parts.filter((part: any) => !part.thought).map((part: any) => part.text ?? "").join("")
    return `${reasoningBlock(thought, includeReasoning)}${text}`
  }
  if (backend.kind === "ollama") return `${reasoningBlock(json.message?.thinking ?? json.thinking ?? "", includeReasoning)}${json.message?.content ?? json.response ?? ""}`
  if (backend.kind === "openai-responses") {
    if (json.type === "response.reasoning_summary_text.delta" || json.type === "response.reasoning.delta") return reasoningBlock(json.delta ?? "", includeReasoning)
    if (json.type === "response.output_text.delta") return json.delta ?? ""
    if (json.type === "response.refusal.delta") return json.delta ?? ""
  }
  const choice = json.choices?.[0]
  const reasoning = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content ?? ""
  if (reasoning) return reasoningBlock(reasoning, includeReasoning)
  return choice?.delta?.content ?? choice?.text ?? ""
}

async function requestLlm(
  editor: Editor,
  deps: GptelDeps,
  backend: GptelBackend,
  model: string,
  messages: GptelMessage[],
  options: { onDelta?: (delta: string) => void; signal?: AbortSignal; tools?: GptelTool[] } = {},
): Promise<RequestResult> {
  if (backend.kind === "mock") {
    const response = `Mock response to: ${messages.at(-1)?.content ?? ""}`
    for (const token of response.match(/.{1,16}/g) ?? []) {
      options.onDelta?.(token)
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    return { text: response }
  }

  const stream = backend.stream !== false && deps.getCustom<boolean>("gptel-stream") !== false && !(options.tools?.length)
  const response = await fetch(backendUrl(backend, model), {
    method: "POST",
    headers: requestHeaders(backend),
    body: JSON.stringify(requestBody(backend, model, messages, deps, stream, options.tools)),
    signal: options.signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`${backend.name} ${response.status}: ${body || response.statusText}`)
  }
  const includeReasoning = includeReasoningSetting(deps)
  if (!stream || !response.body) {
    const json = await response.json()
    return { text: textFromJson(backend, json, includeReasoning), raw: json, usage: usageFromJson(backend, json), toolCalls: toolCallsFromJson(backend, json) }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let text = ""
  let usage: GptelTokenUsage | undefined
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    const complete = pending.split(/\n\n+/)
    pending = complete.pop() ?? ""
    for (const event of parseSseEvents(complete.join("\n\n"))) {
      const parsed = parseJsonMaybe(event)
      if (typeof parsed === "object" && parsed) usage = usageFromJson(backend, parsed) ?? usage
      const delta = textFromStreamEvent(backend, event, includeReasoning)
      if (!delta) continue
      text += delta
      options.onDelta?.(delta)
      void editor.changed("gptel-stream")
    }
  }
  for (const event of parseSseEvents(pending)) {
    const parsed = parseJsonMaybe(event)
    if (typeof parsed === "object" && parsed) usage = usageFromJson(backend, parsed) ?? usage
    const delta = textFromStreamEvent(backend, event, includeReasoning)
    text += delta
    options.onDelta?.(delta)
  }
  return { text, usage }
}

function toolResultString(result: unknown): string {
  if (typeof result === "string") return result
  if (result instanceof Error) return result.message
  try { return JSON.stringify(result, null, 2) } catch { return String(result) }
}

export function gptelToolCallSummary(toolCalls: readonly GptelToolCall[]): string {
  return toolCalls.map((call, index) => {
    const args = toolResultString(call.arguments)
    return `${index + 1}. ${call.name}\n${args}`
  }).join("\n\n")
}

export function formatToolResultBlock(call: GptelToolCall, result: GptelMessage): string {
  const args = toolResultString(call.arguments).replace(/\n/g, " ")
  return [
    `\`\`\` tool (${call.name} ${args})`,
    `(:name ${call.name} :args ${toolResultString(call.arguments)})`,
    "",
    result.content,
    "```",
    "",
  ].join("\n")
}

async function confirmToolCalls(
  editor: Editor,
  deps: GptelDeps,
  toolCalls: readonly GptelToolCall[],
  tools: ReadonlyMap<string, GptelTool>,
): Promise<boolean> {
  if (deps.getCustom<boolean>("gptel-confirm-tool-calls") === false) return true
  const callsNeedingConfirmation = toolCalls.filter(call => tools.get(call.name)?.confirm !== false)
  if (!callsNeedingConfirmation.length) return true
  const names = callsNeedingConfirmation.map(call => call.name).join(", ")
  for (;;) {
    const answer = (await editor.prompt(`Run gptel tool call${callsNeedingConfirmation.length > 1 ? "s" : ""} (${names})? y, n, or i: `, "n", "gptel-tool-confirm"))?.trim().toLowerCase()
    if (answer === "y" || answer === "yes") return true
    if (answer === "i" || answer === "inspect") {
      const buffer = editor.scratch("*gptel tool calls*", `${gptelToolCallSummary(toolCalls)}\n`, "gptel-inspect")
      buffer.readOnly = true
      editor.switchToBuffer(buffer.id)
      continue
    }
    return false
  }
}

async function executeToolCalls(
  editor: Editor,
  deps: GptelDeps,
  buffer: BufferModel,
  toolCalls: readonly GptelToolCall[],
): Promise<GptelMessage[] | null> {
  const st = state(editor)
  const confirmed = await confirmToolCalls(editor, deps, toolCalls, st.tools)
  if (!confirmed) {
    editor.message("gptel: tool calls cancelled")
    return null
  }
  const results: GptelMessage[] = []
  for (const call of toolCalls) {
    const tool = st.tools.get(call.name)
    if (!tool) {
      results.push({
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: `No such gptel tool: ${call.name}`,
      })
      continue
    }
    try {
      editor.message(`gptel tool: ${call.name}`)
      const value = await tool.function(call.arguments, { editor, buffer })
      results.push({
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: toolResultString(value),
      })
    } catch (error) {
      results.push({
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  return results
}

function insertIncludedToolResults(deps: GptelDeps, buffer: BufferModel, calls: readonly GptelToolCall[], results: readonly GptelMessage[], tools: ReadonlyMap<string, GptelTool>): void {
  const blocks: string[] = []
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!
    const call = calls.find(candidate => candidate.id === result.toolCallId) ?? calls[index]
    if (!call || !includeToolResult(deps, tools.get(call.name))) continue
    blocks.push(formatToolResultBlock(call, result))
  }
  if (blocks.length) appendWritable(buffer, `\n${blocks.join("\n")}`)
}

async function requestWithTools(
  editor: Editor,
  deps: GptelDeps,
  backend: GptelBackend,
  model: string,
  messages: GptelMessage[],
  buffer: BufferModel,
  options: { onDelta?: (delta: string) => void; onToolResults?: (calls: GptelToolCall[], results: GptelMessage[], tools: ReadonlyMap<string, GptelTool>) => void; signal?: AbortSignal } = {},
): Promise<RequestResult> {
  const tools = selectedTools(editor, deps)
  const maxRounds = Math.max(0, deps.getCustom<number>("gptel-max-tool-rounds") ?? 3)
  let conversation = [...messages]
  let finalText = ""
  for (let round = 0; round <= maxRounds; round++) {
    const result = await requestLlm(editor, deps, backend, model, conversation, {
      ...options,
      tools,
      onDelta: round === 0 ? options.onDelta : undefined,
    })
    if (result.text) finalText = result.text
    const calls = result.toolCalls ?? []
    if (!calls.length || !tools.length) return { ...result, text: finalText }
    conversation = [
      ...conversation,
      { role: "assistant", content: result.text, toolCalls: calls },
    ]
    const toolResults = await executeToolCalls(editor, deps, buffer, calls)
    if (!toolResults) return { ...result, text: finalText }
    options.onToolResults?.(calls, toolResults, state(editor).tools)
    conversation.push(...toolResults)
    if (round === 0 && options.onDelta && result.text) options.onDelta("\n")
  }
  return { text: finalText }
}

function ensureChatBuffer(editor: Editor, name = GPTEL_BUFFER_PREFIX, markers: GptelChatMarkers = defaultChatMarkers()): BufferModel {
  const existing = [...editor.buffers.values()].find(buffer => buffer.name === name)
  if (existing) {
    editor.switchToBuffer(existing.id)
    editor.enterMode(existing, GPTEL_CHAT_MODE)
    return existing
  }
  const buffer = editor.scratch(name, `# Jemacs gptel\n\n${markerText(markers, "user", true)}`, GPTEL_CHAT_MODE)
  buffer.point = buffer.text.length
  return buffer
}

function applyTransientArgs(editor: Editor, deps: GptelDeps, args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--backend") {
      const value = args[++i]
      if (value) deps.setCustom("gptel-backend", value)
    } else if (arg === "--model") {
      const value = args[++i]
      if (value) deps.setCustom("gptel-model", value)
    } else if (arg === "--system") {
      const value = args[++i]
      if (value) deps.setCustom("gptel-system-message", value)
    } else if (arg === "--temperature") {
      const value = Number(args[++i])
      if (Number.isFinite(value)) deps.setCustom("gptel-temperature", value)
    } else if (arg === "--max-tokens") {
      const value = Number(args[++i])
      if (Number.isFinite(value)) deps.setCustom("gptel-max-tokens", value)
    } else if (arg === "--tools") {
      const value = args[++i]
      if (value != null) deps.setCustom("gptel-tools", value)
    } else if (arg === "--schema") {
      const value = args[++i]
      if (value != null) deps.setCustom("gptel-schema", value)
    } else if (arg === "--reasoning") {
      const value = args[++i]
      if (value != null) deps.setCustom("gptel-include-reasoning", value)
    } else if (arg === "--no-stream") {
      deps.setCustom("gptel-stream", false)
    } else if (arg === "--stream") {
      deps.setCustom("gptel-stream", true)
    } else if (arg === "--context") {
      editor.run("gptel-context").catch(() => undefined)
    }
  }
}

function transientValue(args: string[], flag: string): string | undefined {
  const index = args.findIndex(arg => arg === flag)
  return index >= 0 ? args[index + 1] : undefined
}

function positionalArgs(args: string[]): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg.startsWith("--tool=")) continue
    if (arg.startsWith("--")) {
      if (args[i + 1] && !args[i + 1]!.startsWith("--")) i++
      continue
    }
    values.push(arg)
  }
  return values
}

async function sendFromBuffer(editor: Editor, deps: GptelDeps, buffer: BufferModel, args: string[] = [], priorVariants: string[] = []): Promise<void> {
  applyTransientArgs(editor, deps, args)
  const markers = chatMarkers(deps)
  const { prompt } = extractPrompt(buffer, markers)
  if (!prompt) {
    editor.message("gptel: empty prompt")
    return
  }
  const backend = backendByName(editor, deps)
  const model = currentModel(editor, deps, backend)
  const messages = await buildMessages(editor, deps, buffer, prompt, backend, model, markers)
  const controller = new AbortController()
  state(editor).activeRequests.set(buffer.id, controller)

  const insertionStart = buffer.text.length
  appendWritable(buffer, markerText(markers, "assistant"))
  const responseStart = buffer.text.length
  editor.message(`gptel: ${backend.name}/${model}`)
  try {
    await editor.runHook("gptel-pre-response-hook", buffer)
    await editor.runHook("gptel-post-request-hook", buffer)
    const result = await requestWithTools(editor, deps, backend, model, messages, buffer, {
      signal: controller.signal,
      onToolResults(calls, results, tools) {
        insertIncludedToolResults(deps, buffer, calls, results, tools)
      },
      onDelta(delta) {
        appendWritable(buffer, delta)
        buffer.point = buffer.text.length
        void editor.runHook("gptel-post-stream-hook", buffer)
      },
    })
    const insertedResponse = buffer.text.slice(responseStart)
    if (result.text && !insertedResponse.includes(result.text)) appendWritable(buffer, result.text)
    let finalResponse = await applyResponseFilters(editor, buffer, backend, model, buffer.text.slice(responseStart))
    if (shouldConvertResponseToOrg(deps, buffer)) finalResponse = convertMarkdownToOrg(finalResponse)
    if (finalResponse !== buffer.text.slice(responseStart)) replaceWritable(buffer, responseStart, buffer.text.length, finalResponse)
    const responseEnd = buffer.text.length
    const responseText = buffer.text.slice(responseStart, responseEnd)
    const st = state(editor)
    st.tokenUsage = addUsage(st.tokenUsage, result.usage)
    await runPostResponseFunctions(editor, buffer, backend, model, responseStart, responseEnd)
    appendWritable(buffer, markerText(markers, "user"))
    buffer.point = buffer.text.length
    st.lastRequest = {
      bufferId: buffer.id,
      prompt,
      messages,
      insertionStart,
      responseStart,
      responseEnd,
      insertionEnd: buffer.text.length,
      backend: backend.name,
      model,
      usage: result.usage,
      variants: [responseText, ...priorVariants.filter(variant => variant !== responseText)],
      variantIndex: 0,
    }
    editor.message(`gptel: done (${backend.name}/${model})`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendWritable(buffer, `${markers.separator}[gptel error] ${message}${markerText(markers, "user")}`)
    editor.message(`gptel failed: ${message}`)
  } finally {
    state(editor).activeRequests.delete(buffer.id)
    void editor.changed("gptel-send")
  }
}

function switchLastVariant(editor: Editor, direction: number): void {
  const st = state(editor)
  const last = st.lastRequest
  if (!last || last.variants.length < 2) {
    editor.message("gptel: no response variants")
    return
  }
  const buffer = editor.buffers.get(last.bufferId)
  if (!buffer) return
  const nextIndex = (last.variantIndex + direction + last.variants.length) % last.variants.length
  const next = last.variants[nextIndex] ?? ""
  const oldLength = last.responseEnd - last.responseStart
  replaceWritable(buffer, last.responseStart, last.responseEnd, next)
  const delta = next.length - oldLength
  last.responseEnd += delta
  last.insertionEnd += delta
  last.variantIndex = nextIndex
  buffer.point = last.responseStart + next.length
  editor.message(`gptel: variant ${nextIndex + 1}/${last.variants.length}`)
  void editor.changed("gptel-variant")
}

function moveResponseBoundary(editor: Editor, deps: GptelDeps, buffer: BufferModel, boundary: "start" | "end", direction: number): void {
  const markers = chatMarkers(deps)
  const ranges = responseRanges(buffer, markers)
  const current = direction >= 0
    ? ranges.find(range => range[boundary] > buffer.point)
    : [...ranges].reverse().find(range => range[boundary] < buffer.point)
  if (!current) {
    editor.message(`gptel: no ${direction >= 0 ? "next" : "previous"} response`)
    return
  }
  buffer.point = current[boundary]
}

function markResponse(editor: Editor, deps: GptelDeps, buffer: BufferModel): void {
  const range = responseRangeAtPoint(buffer, chatMarkers(deps))
  if (!range) {
    editor.message("gptel: no response at point")
    return
  }
  buffer.point = range.start
  buffer.mark = range.end
  buffer.markActive = true
  editor.message("gptel: marked response")
}

async function rewriteRegion(editor: Editor, deps: GptelDeps, buffer: BufferModel, instruction: string): Promise<void> {
  const bounds = regionBounds(buffer)
  if (!bounds) {
    editor.message("gptel-rewrite: mark a region first")
    return
  }
  const original = buffer.text.slice(bounds[0], bounds[1])
  const backend = backendByName(editor, deps)
  const model = currentModel(editor, deps, backend)
  const messages: GptelMessage[] = [
    { role: "system", content: "Rewrite the provided text according to the instruction. Return only the rewritten text." },
    { role: "user", content: `Instruction:\n${instruction}\n\nText:\n${original}` },
  ]
  editor.message(`gptel-rewrite: ${backend.name}/${model}`)
  const result = await requestWithTools(editor, deps, backend, model, messages, buffer)
  const replacement = result.text.trim()
  replaceWritable(buffer, bounds[0], bounds[1], replacement)
  state(editor).lastRewrite = {
    bufferId: buffer.id,
    start: bounds[0],
    end: bounds[0] + replacement.length,
    original,
    replacement,
    instruction,
  }
  await editor.runHook("gptel-post-rewrite-functions", buffer)
  editor.message("gptel-rewrite: replaced region; use gptel-rewrite-reject to restore")
  void editor.changed("gptel-rewrite")
}

function acceptRewrite(editor: Editor): void {
  const st = state(editor)
  if (!st.lastRewrite) {
    editor.message("gptel-rewrite: no pending rewrite")
    return
  }
  st.lastRewrite = undefined
  editor.message("gptel-rewrite: accepted")
}

function rejectRewrite(editor: Editor): void {
  const st = state(editor)
  const rewrite = st.lastRewrite
  if (!rewrite) {
    editor.message("gptel-rewrite: no pending rewrite")
    return
  }
  const buffer = editor.buffers.get(rewrite.bufferId)
  if (!buffer) {
    st.lastRewrite = undefined
    return
  }
  replaceWritable(buffer, rewrite.start, rewrite.end, rewrite.original)
  buffer.point = rewrite.start + rewrite.original.length
  st.lastRewrite = undefined
  editor.message("gptel-rewrite: restored original text")
  void editor.changed("gptel-rewrite-reject")
}

async function collectDirectory(path: string, limit = 24): Promise<Array<{ path: string; text: string }>> {
  const files: Array<{ path: string; text: string }> = []
  async function walk(dir: string): Promise<void> {
    if (files.length >= limit) return
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (files.length >= limit || entry.name.startsWith(".") || entry.name === "node_modules") continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        const size = statSync(full).size
        if (size > 100_000) continue
        const text = await readFile(full, "utf8").catch(() => "")
        files.push({ path: full, text })
      }
    }
  }
  await walk(path)
  return files
}

async function addPathContext(editor: Editor, path: string): Promise<void> {
  const full = resolve(path)
  const st = await stat(full)
  if (st.isDirectory()) {
    state(editor).context.push({ type: "directory", path: full, files: await collectDirectory(full) })
    editor.message(`gptel: added directory context ${full}`)
  } else {
    const mime = mimeTypeForPath(full) ?? undefined
    const binary = st.size > 200_000 || (mime ? !isTextMime(mime) : false)
    const text = binary ? "" : await readFile(full, "utf8").catch(() => "")
    state(editor).context.push({ type: "file", path: full, text, binary, mime })
    editor.message(`gptel: added file context ${full}`)
  }
}

function installFaces(deps: GptelDeps): void {
  deps.defface("gptel-user", { fg: "#83a598", bold: true }, "gptel user prompt face.")
  deps.defface("gptel-assistant", { fg: "#b8bb26", bold: true }, "gptel assistant response face.")
  deps.defface("gptel-context", { fg: "#fabd2f" }, "gptel context face.")
  deps.defface("gptel-error", { fg: "#fb4934", bold: true }, "gptel error face.")
}

function gptelFontLock(buffer: BufferModel) {
  const spans: Array<{ start: number; end: number; face: any }> = []
  for (const match of buffer.text.matchAll(/^(User|Assistant):/gm)) {
    spans.push({ start: match.index, end: match.index + match[0].length, face: match[1] === "User" ? "gptel-user" : "gptel-assistant" })
  }
  for (const match of buffer.text.matchAll(/\[gptel error\].*$/gm)) {
    spans.push({ start: match.index, end: match.index + match[0].length, face: "gptel-error" })
  }
  return spans
}

function installModes(deps: GptelDeps): void {
  const chatMap = new deps.Keymap("gptel-chat-map")
  chatMap.bind("C-c RET", "gptel-send")
  chatMap.bind("C-c C-c", "gptel-send")
  chatMap.bind("C-c C-k", "gptel-abort")
  chatMap.bind("C-c C-r", "gptel-rewrite")
  chatMap.bind("M-p", "gptel-beginning-of-response")
  chatMap.bind("M-n", "gptel-end-of-response")
  chatMap.bind("C-c C-v p", "gptel-previous-variant")
  chatMap.bind("C-c C-v n", "gptel-next-variant")
  chatMap.bind("C-c C-a", "gptel-add")
  chatMap.bind("C-c C-n", "gptel-context-remove-all")
  deps.defineMode({ name: GPTEL_CHAT_MODE, parent: "markdown", keymap: chatMap, fontLock: gptelFontLock })

  const contextMap = new deps.Keymap("gptel-context-map")
  contextMap.bind("C-c C-c", "gptel-context-confirm")
  contextMap.bind("C-c C-k", "gptel-context-quit")
  contextMap.bind("RET", "gptel-context-visit")
  contextMap.bind("return", "gptel-context-visit")
  contextMap.bind("enter", "gptel-context-visit")
  contextMap.bind("n", "gptel-context-next")
  contextMap.bind("p", "gptel-context-previous")
  contextMap.bind("d", "gptel-context-flag-deletion")
  contextMap.bind("g", "gptel-context")
  deps.defineMode({ name: GPTEL_CONTEXT_MODE, parent: "text", keymap: contextMap })

  const minorMap = new deps.Keymap("gptel-mode-map")
  minorMap.bind("C-c RET", "gptel-send")
  minorMap.bind("C-c C-c", "gptel-send")
  minorMap.bind("C-c C-r", "gptel-rewrite")
  minorMap.bind("C-c C-a", "gptel-add")
  minorMap.bind("M-p", "gptel-beginning-of-response")
  minorMap.bind("M-n", "gptel-end-of-response")
  deps.defineMinorMode({ name: GPTEL_MODE, lighter: " GPTel", keymap: minorMap })
}

function contextBuffer(editor: Editor): BufferModel {
  const st = state(editor)
  const existing = [...editor.buffers.values()].find(buffer => buffer.name === "*gptel-context*")
  const flagged = existing?.locals.get(CONTEXT_FLAGGED) as Set<number> | undefined ?? new Set<number>()
  const rendered = renderContextBuffer(st.context, flagged)
  const buffer = existing
    ? editor.switchToBuffer(existing.id)
    : editor.scratch("*gptel-context*", "", GPTEL_CONTEXT_MODE)
  const wasReadOnly = buffer.readOnly
  buffer.readOnly = false
  buffer.setText(rendered.text, false)
  buffer.readOnly = true || wasReadOnly
  buffer.locals.set(CONTEXT_SECTIONS, rendered.sections)
  buffer.locals.set(CONTEXT_FLAGGED, flagged)
  editor.enterMode(buffer, GPTEL_CONTEXT_MODE)
  return buffer
}

function contextSections(buffer: BufferModel): GptelContextSection[] {
  return (buffer.locals.get(CONTEXT_SECTIONS) as GptelContextSection[] | undefined) ?? []
}

function contextFlagged(buffer: BufferModel): Set<number> {
  let flagged = buffer.locals.get(CONTEXT_FLAGGED) as Set<number> | undefined
  if (!flagged) {
    flagged = new Set()
    buffer.locals.set(CONTEXT_FLAGGED, flagged)
  }
  return flagged
}

function contextSectionAtPoint(buffer: BufferModel): GptelContextSection | undefined {
  const sections = contextSections(buffer)
  return sections.find(section => buffer.point >= section.start && buffer.point <= section.end)
    ?? sections.find(section => buffer.point < section.start)
    ?? sections.at(-1)
}

function moveContextSection(buffer: BufferModel, delta: number): boolean {
  const sections = contextSections(buffer)
  if (!sections.length) return false
  const current = contextSectionAtPoint(buffer)
  const currentIndex = current ? sections.indexOf(current) : -1
  const next = Math.max(0, Math.min(sections.length - 1, currentIndex + delta))
  buffer.point = sections[next]!.start
  return true
}

async function visitContextItem(editor: Editor, item: GptelContextItem): Promise<void> {
  if (item.type === "buffer" || item.type === "region") {
    const buffer = editor.buffers.get(item.bufferId)
    if (!buffer) {
      editor.message(`gptel: source buffer no longer exists: ${item.name}`)
      return
    }
    editor.switchToBuffer(buffer.id)
    if (item.type === "region") {
      buffer.point = item.start
      buffer.mark = item.end
      buffer.markActive = true
    }
    return
  }
  if (item.type === "file") {
    await editor.openFile(item.path)
    return
  }
  if (item.type === "directory") {
    await editor.openDirectory(item.path)
    return
  }
  editor.message(`gptel: text context ${item.name} has no source to visit`)
}

function describeState(editor: Editor, deps: GptelDeps): string {
  const st = state(editor)
  const backend = backendByName(editor, deps)
  const model = currentModel(editor, deps, backend)
  return [
    "gptel",
    "",
    `Backend: ${backend.name}`,
    `Model: ${model}`,
    `Stream: ${deps.getCustom<boolean>("gptel-stream") !== false ? "yes" : "no"}`,
    `Last usage: ${formatUsage(st.lastRequest?.usage)}`,
    `Session usage: ${formatUsage(st.tokenUsage)}`,
    `Context items: ${st.context.length}`,
    `Presets: ${[...st.presets.keys()].join(", ") || "(none)"}`,
    `Tools: ${[...st.tools.keys()].join(", ") || "(none)"}`,
    `Schema: ${deps.getCustom<string>("gptel-schema") ? "yes" : "no"}`,
    "",
    "Commands:",
    "  gptel                  open a chat buffer",
    "  gptel-send             send region, prompt, or chat turn",
    "  gptel-add              add region/current buffer to context",
    "  gptel-add-file         add a file or directory to context",
    "  gptel-rewrite          rewrite active region",
    "  gptel-rewrite-accept   accept the last rewrite",
    "  gptel-rewrite-reject   reject the last rewrite",
    "  gptel-regenerate       regenerate the last response",
    "  gptel-previous-variant cycle response variants",
    "  gptel-mark-response    mark the response at point",
    "  gptel-openai-oauth-login save OpenAI OAuth token",
    "  gptel-gh-login         save GitHub Copilot token",
    "  gptel-menu             inspect and change backend/model",
    "  gptel-abort            abort active request",
  ].join("\n")
}

function knownDirectives(): Record<string, string> {
  return {
    default: "You are a helpful assistant.",
    concise: "You are a helpful assistant. Answer as concisely as possible.",
    shell: "Reply only with shell commands and no prose.",
    poet: "You are a poet. Reply only in verse.",
    code: "You are a careful programming assistant. Prefer small, correct patches and explain tradeoffs briefly.",
    rewrite: "You are a writing assistant. Rewrite the provided text according to the user's instruction and return only the replacement text.",
  }
}

function directiveNames(): string[] {
  return Object.keys(knownDirectives())
}

function gptelToolsDefinition(editor: Editor, deps: GptelDeps): TransientDefinition {
  const selected = new Set((deps.getCustom<string>("gptel-tools") ?? "").split(/[, ]+/).filter(Boolean))
  const toolInfixes = [...state(editor).tools.values()].sort((a, b) => a.name.localeCompare(b.name)).map((tool, index) => ({
    key: String(index + 1),
    label: tool.description ? `${tool.name} - ${tool.description}` : tool.name,
    argument: `--tool=${tool.name}`,
    kind: "toggle" as const,
    defaultValue: selected.has(tool.name),
  }))
  return {
    name: "gptel-tools",
    title: "gptel tools",
    groups: [
      {
        title: "Options",
        infixes: [
          { key: "-u", label: "Use tools", argument: "--use-tools", kind: "toggle", defaultValue: deps.getCustom<boolean | string>("gptel-use-tools") !== false },
          { key: "-c", label: "Confirm calls", argument: "--confirm-tools", kind: "toggle", defaultValue: deps.getCustom<boolean>("gptel-confirm-tool-calls") !== false },
          { key: "-i", label: "Include results", argument: "--include-tool-results", kind: "value", defaultValue: String(deps.getCustom<boolean | string>("gptel-include-tool-results") ?? "auto") },
        ],
      },
      {
        title: "Registered Tools",
        infixes: toolInfixes,
        suffixes: [
          { key: "RET", label: "Apply", command: "gptel-tools-apply" },
        ],
      },
    ],
  }
}

const gptelSystemPromptDefinition: TransientDefinition = {
  name: "gptel-system-prompt",
  title: "gptel system prompt",
  groups: [
    {
      title: "Edit",
      infixes: [
        { key: "-s", label: "System prompt", argument: "--system", kind: "value" },
      ],
      suffixes: [
        { key: "RET", label: "Set prompt", command: "gptel-system-prompt-set" },
      ],
    },
    {
      title: "Directives",
      suffixes: directiveNames().map((name, index) => ({ key: String(index + 1), label: name, command: "gptel-system-prompt-set", args: [name] })),
    },
  ],
}

const gptelRewriteDefinition: TransientDefinition = {
  name: "gptel-rewrite",
  title: "gptel rewrite",
  groups: [
    {
      title: "Rewrite",
      infixes: [
        { key: "-i", label: "Instruction", argument: "--instruction", kind: "value" },
      ],
      suffixes: [
        { key: "r", label: "Rewrite", command: "gptel-rewrite-run" },
        { key: "a", label: "Accept", command: "gptel-rewrite-accept" },
        { key: "k", label: "Reject", command: "gptel-rewrite-reject" },
      ],
    },
    {
      title: "Directives",
      suffixes: directiveNames().map((name, index) => ({ key: String(index + 1), label: name, command: "gptel-rewrite-run", args: [name] })),
    },
  ],
}

const gptelMenuDefinition: TransientDefinition = {
  name: "gptel-menu",
  title: "gptel",
  groups: [
    {
      title: "Options",
      infixes: [
        { key: "-b", label: "Backend", argument: "--backend", kind: "value" },
        { key: "-m", label: "Model", argument: "--model", kind: "value" },
        { key: "-s", label: "System", argument: "--system", kind: "value" },
        { key: "-t", label: "Temperature", argument: "--temperature", kind: "value" },
        { key: "-n", label: "Max tokens", argument: "--max-tokens", kind: "value" },
        { key: "-T", label: "Tools", argument: "--tools", kind: "value" },
        { key: "-S", label: "Schema", argument: "--schema", kind: "value" },
        { key: "-v", label: "Reasoning", argument: "--reasoning", kind: "value" },
        { key: "-x", label: "No stream", argument: "--no-stream", kind: "toggle" },
      ],
    },
    {
      title: "Actions",
      suffixes: [
        { key: "RET", label: "Send", command: "gptel-send" },
        { key: "g", label: "Open chat", command: "gptel" },
        { key: "a", label: "Add context", command: "gptel-add" },
        { key: "f", label: "Add file", command: "gptel-add-file" },
        { key: "c", label: "Show context", command: "gptel-context" },
        { key: "x", label: "Clear context", command: "gptel-context-remove-all" },
        { key: "r", label: "Rewrite region", command: "gptel-rewrite" },
        { key: "u a", label: "Accept rewrite", command: "gptel-rewrite-accept" },
        { key: "u r", label: "Reject rewrite", command: "gptel-rewrite-reject" },
        { key: "R", label: "Regenerate", command: "gptel-regenerate" },
        { key: "v p", label: "Previous variant", command: "gptel-previous-variant" },
        { key: "v n", label: "Next variant", command: "gptel-next-variant" },
        { key: "m", label: "Mark response", command: "gptel-mark-response" },
        { key: "y", label: "Copy response", command: "gptel-copy-last-response" },
        { key: "p", label: "Preset", command: "gptel-preset" },
        { key: "T", label: "Tools", command: "gptel-tools" },
        { key: "i", label: "Inspect", command: "gptel-inspect" },
        { key: "A", label: "Abort", command: "gptel-abort" },
      ],
    },
  ],
}

function makeBackend(kind: GptelBackendKind, name: string, options: Partial<GptelBackend>): GptelBackend {
  return {
    name,
    kind,
    models: options.models ?? [options.defaultModel ?? "model"],
    ...options,
  }
}

function registerBackend(editor: Editor, backend: GptelBackend): GptelBackend {
  state(editor).backends.set(backend.name, backend)
  return backend
}

export function gptelMakeOpenAI(editor: Editor, name: string, options: Partial<GptelBackend> = {}): GptelBackend {
  return registerBackend(editor, makeBackend("openai", name, {
    host: "api.openai.com",
    endpoint: "/v1/chat/completions",
    stream: true,
    ...options,
  }))
}

export function gptelMakeOpenAIResponses(editor: Editor, name: string, options: Partial<GptelBackend> = {}): GptelBackend {
  return registerBackend(editor, makeBackend("openai-responses", name, {
    host: "api.openai.com",
    endpoint: "/v1/responses",
    stream: true,
    ...options,
  }))
}

export function gptelMakeAzure(editor: Editor, name: string, options: Partial<GptelBackend> = {}): GptelBackend {
  return registerBackend(editor, makeBackend("openai", name, {
    protocol: "https",
    apiKeyHeader: "api-key",
    endpoint: "/openai/deployments/{model}/chat/completions?api-version=2024-10-21",
    stream: true,
    ...options,
  }))
}

export function gptelMakeOllama(editor: Editor, name: string, options: Partial<GptelBackend> = {}): GptelBackend {
  return registerBackend(editor, makeBackend("ollama", name, {
    protocol: "http",
    host: "localhost:11434",
    endpoint: "/api/chat",
    stream: true,
    ...options,
  }))
}

export function gptelMakeAnthropic(editor: Editor, name: string, options: Partial<GptelBackend> = {}): GptelBackend {
  return registerBackend(editor, makeBackend("anthropic", name, {
    host: "api.anthropic.com",
    endpoint: "/v1/messages",
    stream: true,
    ...options,
  }))
}

export function gptelMakeGemini(editor: Editor, name: string, options: Partial<GptelBackend> = {}): GptelBackend {
  return registerBackend(editor, makeBackend("gemini", name, {
    host: "generativelanguage.googleapis.com",
    endpoint: "/v1beta/models/{model}:streamGenerateContent",
    stream: true,
    ...options,
  }))
}

export function gptelMakeKagi(editor: Editor, name: string, options: Partial<GptelBackend> = {}): GptelBackend {
  return registerBackend(editor, makeBackend("kagi", name, {
    host: "kagi.com",
    endpoint: "/api/v0/{kagiAction}",
    models: ["fastgpt", "summarize:cecil", "summarize:agnes", "summarize:daphne", "summarize:muriel"],
    defaultModel: "fastgpt",
    stream: false,
    authorizationPrefix: "Bot",
    ...options,
  }))
}

export function gptelMakePrivateGPT(editor: Editor, name: string, options: Partial<GptelBackend> = {}): GptelBackend {
  return registerBackend(editor, makeBackend("openai", name, {
    protocol: "http",
    host: "localhost:8001",
    endpoint: "/v1/chat/completions",
    models: ["private-gpt"],
    defaultModel: "private-gpt",
    stream: false,
    ...options,
  }))
}

export function gptelMakePerplexity(editor: Editor, name: string, options: Partial<GptelBackend> = {}): GptelBackend {
  return registerBackend(editor, makeBackend("openai", name, {
    host: "api.perplexity.ai",
    endpoint: "/chat/completions",
    models: ["sonar", "sonar-pro", "sonar-reasoning", "sonar-reasoning-pro", "sonar-deep-research"],
    defaultModel: "sonar",
    stream: true,
    ...options,
  }))
}

export function gptelMakeDeepSeek(editor: Editor, name: string, options: Partial<GptelBackend> = {}): GptelBackend {
  return registerBackend(editor, makeBackend("openai", name, {
    host: "api.deepseek.com",
    endpoint: "/v1/chat/completions",
    models: ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash", "deepseek-v4-pro"],
    defaultModel: "deepseek-chat",
    stream: true,
    ...options,
  }))
}

export function gptelMakeXAI(editor: Editor, name: string, options: Partial<GptelBackend> = {}): GptelBackend {
  return registerBackend(editor, makeBackend("openai", name, {
    host: "api.x.ai",
    endpoint: "/v1/chat/completions",
    models: ["grok-4-1-fast-reasoning", "grok-4-1-fast-non-reasoning", "grok-code-fast-1", "grok-4-fast-reasoning"],
    defaultModel: "grok-4-1-fast-reasoning",
    stream: true,
    ...options,
  }))
}

export function gptelMakeBedrock(editor: Editor, name: string, options: Partial<GptelBackend> = {}): GptelBackend {
  const region = options.host?.match(/^bedrock-runtime\.([^.]+)\.amazonaws\.com$/)?.[1] ?? "us-east-1"
  return registerBackend(editor, makeBackend("bedrock", name, {
    host: `bedrock-runtime.${region}.amazonaws.com`,
    endpoint: "/model/{model}/converse",
    models: ["claude-sonnet-4-5-20250929", "claude-opus-4-1-20250805", "nova-2-lite-v1", "llama-3-3-70b"],
    defaultModel: "claude-sonnet-4-5-20250929",
    stream: false,
    ...options,
  }))
}

export function gptelMakeGithubCopilot(editor: Editor, name: string, options: Partial<GptelBackend> = {}): GptelBackend {
  return registerBackend(editor, makeBackend("openai", name, {
    host: "api.githubcopilot.com",
    endpoint: "/chat/completions",
    models: ["gpt-5.2", "gpt-5.1-codex", "claude-sonnet-4-5", "gemini-2.5-pro"],
    defaultModel: "gpt-5.2",
    stream: true,
    key: () => apiKey("GITHUB_COPILOT_TOKEN") || tokenFromFile(emacsCachePath("copilot-chat", "token")),
    headers: {
      "openai-intent": "conversation-panel",
      "x-initiator": "user",
      "copilot-integration-id": "vscode-chat",
      ...(options.headers ?? {}),
    },
    ...options,
  }))
}

export function gptelMakeOpenAIOAuth(editor: Editor, name: string, options: Partial<GptelBackend> = {}): GptelBackend {
  return registerBackend(editor, makeBackend("openai-responses", name, {
    host: "chatgpt.com",
    endpoint: "/backend-api/codex/responses",
    models: ["gpt-5.2", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.4-mini", "gpt-5.4", "gpt-5.5"],
    defaultModel: "gpt-5.3-codex",
    stream: true,
    key: () => apiKey("OPENAI_OAUTH_TOKEN") || tokenFromFile(emacsCachePath("gptel-openai", "openai-oauth-token")),
    ...options,
  }))
}

export function gptelMakeTool(editor: Editor, tool: GptelTool): GptelTool {
  state(editor).tools.set(tool.name, tool)
  return tool
}

export function gptelMakePreset(editor: Editor, preset: GptelPreset): GptelPreset {
  state(editor).presets.set(preset.name, preset)
  return preset
}

export function gptelAddPromptTransform(editor: Editor, transform: GptelPromptTransform): GptelPromptTransform {
  state(editor).promptTransforms.push(transform)
  return transform
}

export function gptelAddResponseFilter(editor: Editor, filter: GptelResponseFilter): GptelResponseFilter {
  state(editor).responseFilters.push(filter)
  return filter
}

export function gptelAddPostResponseFunction(editor: Editor, fn: GptelPostResponseFunction): GptelPostResponseFunction {
  state(editor).postResponseFunctions.push(fn)
  return fn
}

async function applyPreset(editor: Editor, deps: GptelDeps, name: string): Promise<void> {
  const preset = state(editor).presets.get(name)
  if (!preset) {
    editor.message(`gptel: no preset ${name}`)
    return
  }
  if (preset.backend) deps.setCustom("gptel-backend", preset.backend)
  if (preset.model) deps.setCustom("gptel-model", preset.model)
  if (preset.system) deps.setCustom("gptel-system-message", preset.system)
  if (typeof preset.temperature === "number") deps.setCustom("gptel-temperature", preset.temperature)
  if (preset.schema != null) deps.setCustom("gptel-schema", typeof preset.schema === "string" ? preset.schema : JSON.stringify(preset.schema))
  if (preset.tools) deps.setCustom("gptel-tools", preset.tools.join(","))
  editor.message(`gptel: applied preset ${name}`)
}

export async function install(editor: Editor): Promise<void> {
  const deps = await loadDeps()
  state(editor)
  installFaces(deps)
  installModes(deps)

  deps.defcustom("gptel-backend", "string", "Claude", "Active gptel backend.", "gptel")
  deps.defcustom("gptel-model", "string", "claude-sonnet-4-5-20250929", "Active gptel model.", "gptel")
  deps.defcustom("gptel-system-message", "string", "You are a helpful assistant.", "System message used for gptel requests.", "gptel")
  deps.defcustom("gptel-temperature", "number", 0.7, "Sampling temperature for gptel requests.", "gptel")
  deps.defcustom("gptel-max-tokens", "number", 4096, "Maximum output tokens for gptel requests.", "gptel")
  deps.defcustom("gptel-stream", "boolean", true, "Stream gptel responses into the current buffer.", "gptel")
  deps.defcustom("gptel-use-tools", "boolean", true, "Whether selected gptel tools are made available to models.", "gptel")
  deps.defcustom("gptel-tools", "string", "", "Comma or space separated gptel tool names to include with requests.", "gptel")
  deps.defcustom("gptel-include-tool-results", "string", "auto", "Whether tool results are inserted in gptel buffers: auto, true, or false.", "gptel")
  deps.defcustom("gptel-max-tool-rounds", "number", 3, "Maximum number of tool-call continuation rounds.", "gptel")
  deps.defcustom("gptel-confirm-tool-calls", "boolean", true, "Ask before running gptel tool calls.", "gptel")
  deps.defcustom("gptel-schema", "string", "", "Structured JSON output schema as JSON or gptel shorthand.", "gptel")
  deps.defcustom("gptel-include-reasoning", "string", "ignore", "Reasoning handling: ignore, true, false, or a buffer name.", "gptel")
  deps.defcustom("gptel-prompt-prefix", "string", "User:\n", "String inserted before user prompts in gptel chat buffers.", "gptel")
  deps.defcustom("gptel-response-prefix", "string", "Assistant:\n", "String inserted before assistant responses in gptel chat buffers.", "gptel")
  deps.defcustom("gptel-response-separator", "string", "\n\n", "String inserted between gptel prompt and response sections.", "gptel")
  deps.defcustom("gptel-pre-response-hook", "string", "", "Hook run before inserting a gptel response.", "gptel")
  deps.defcustom("gptel-post-response-functions", "string", "", "Hook run after inserting a gptel response.", "gptel")
  deps.defcustom("gptel-post-stream-hook", "string", "", "Hook run after each streaming response insertion.", "gptel")
  deps.defcustom("gptel-post-request-hook", "string", "", "Hook run after sending a gptel request.", "gptel")
  deps.defcustom("gptel-post-rewrite-functions", "string", "", "Hook run after a gptel rewrite is inserted.", "gptel")
  deps.defcustom("gptel-org-convert-response", "boolean", true, "Convert Markdown responses to Org syntax in org-mode buffers.", "gptel")

  editor.command("gptel", async ({ editor, args }) => {
    const name = args.join(" ") || GPTEL_BUFFER_PREFIX
    ensureChatBuffer(editor, name, chatMarkers(deps))
  }, "Start or switch to a gptel chat buffer.")

  editor.command("gptel-send", async ({ editor, buffer, args }) => {
    if (buffer.mode !== GPTEL_CHAT_MODE && !buffer.minorModes.has(GPTEL_MODE)) editor.enableMinorMode(GPTEL_MODE, { buffer })
    await sendFromBuffer(editor, deps, buffer, args)
  }, "Send the active region, chat prompt, or buffer prefix to the configured LLM.")

  editor.command("gptel-menu", ({ editor }) => {
    editor.openTransient(gptelMenuDefinition)
  }, "Open a compact gptel command menu.")

  editor.command("gptel-add", async ({ editor, buffer }) => {
    const region = activeRegionText(buffer)
    if (region) {
      const [start, end] = regionBounds(buffer)!
      state(editor).context.push({ type: "region", name: editor.bufferDisplayName(buffer), bufferId: buffer.id, start, end, text: region })
      editor.message("gptel: added region context")
      return
    }
    state(editor).context.push({ type: "buffer", name: editor.bufferDisplayName(buffer), bufferId: buffer.id, text: buffer.text })
    editor.message("gptel: added buffer context")
  }, "Add active region or current buffer to gptel context.")

  editor.command("gptel-add-file", async ({ editor, args }) => {
    const picked = args[0] ?? await editor.completingRead("Add file or directory: ", { completion: "file", history: "file" })
    if (!picked) return
    await addPathContext(editor, picked)
  }, "Add a file or directory to gptel context.")

  editor.command("gptel-context-remove-all", ({ editor }) => {
    state(editor).context.length = 0
    editor.message("gptel: cleared context")
  }, "Remove all gptel context.")

  editor.command("gptel-context", ({ editor }) => {
    contextBuffer(editor)
  }, "Show current gptel context.")

  editor.command("gptel-context-next", ({ editor, buffer }) => {
    if (buffer.mode !== GPTEL_CONTEXT_MODE || !moveContextSection(buffer, 1)) editor.message("gptel: no next context")
  }, "Move to the next gptel context entry.")

  editor.command("gptel-context-previous", ({ editor, buffer }) => {
    if (buffer.mode !== GPTEL_CONTEXT_MODE || !moveContextSection(buffer, -1)) editor.message("gptel: no previous context")
  }, "Move to the previous gptel context entry.")

  editor.command("gptel-context-flag-deletion", ({ editor, buffer }) => {
    if (buffer.mode !== GPTEL_CONTEXT_MODE) return
    const section = contextSectionAtPoint(buffer)
    if (!section) {
      editor.message("gptel: no context entry here")
      return
    }
    const flagged = contextFlagged(buffer)
    if (flagged.has(section.index)) flagged.delete(section.index)
    else flagged.add(section.index)
    const point = buffer.point
    contextBuffer(editor).point = point
  }, "Mark or unmark the current context entry for deletion.")

  editor.command("gptel-context-confirm", ({ editor, buffer }) => {
    if (buffer.mode !== GPTEL_CONTEXT_MODE) return
    const flagged = [...contextFlagged(buffer)].sort((a, b) => b - a)
    const st = state(editor)
    for (const index of flagged) st.context.splice(index, 1)
    buffer.locals.set(CONTEXT_FLAGGED, new Set<number>())
    contextBuffer(editor)
    editor.message(`gptel: removed ${flagged.length} context item${flagged.length === 1 ? "" : "s"}`)
  }, "Apply deletion marks in the gptel context buffer.")

  editor.command("gptel-context-quit", ({ editor }) => {
    const other = editor.otherBuffer()
    if (other) editor.switchToBuffer(other.id)
  }, "Quit the gptel context buffer.")

  editor.command("gptel-context-visit", async ({ editor, buffer }) => {
    if (buffer.mode !== GPTEL_CONTEXT_MODE) return
    const section = contextSectionAtPoint(buffer)
    const item = section ? state(editor).context[section.index] : undefined
    if (!item) {
      editor.message("gptel: no context entry here")
      return
    }
    await visitContextItem(editor, item)
  }, "Visit the source for the current gptel context entry.")

  editor.command("gptel-context-remove", ({ editor, buffer }) => {
    if (buffer.mode === GPTEL_CONTEXT_MODE) {
      const section = contextSectionAtPoint(buffer)
      if (section) {
        state(editor).context.splice(section.index, 1)
        contextBuffer(editor)
        editor.message("gptel: removed context entry")
      }
      return
    }
    const st = state(editor)
    const before = st.context.length
    st.context = st.context.filter(item =>
      !(("bufferId" in item) && item.bufferId === buffer.id))
    editor.message(`gptel: removed ${before - st.context.length} context item${before - st.context.length === 1 ? "" : "s"}`)
  }, "Remove gptel context for this buffer or current context entry.")

  editor.command("gptel-rewrite", async ({ editor, buffer, args }) => {
    applyTransientArgs(editor, deps, args)
    if (buffer.useRegion()) {
      const instruction = positionalArgs(args).join(" ") || await editor.prompt("Rewrite instruction: ", "Improve clarity while preserving meaning.", "gptel-rewrite")
      if (!instruction) return
      await rewriteRegion(editor, deps, buffer, instruction)
      return
    }
    editor.openTransient(gptelRewriteDefinition)
  }, "Rewrite the active region using gptel.")

  editor.command("gptel-rewrite-run", async ({ editor, buffer, args }) => {
    applyTransientArgs(editor, deps, args)
    const directive = positionalArgs(args).find(arg => knownDirectives()[arg])
    const instruction = transientValue(args, "--instruction")
      ?? (directive ? knownDirectives()[directive] : await editor.prompt("Rewrite instruction: ", "Improve clarity while preserving meaning.", "gptel-rewrite"))
    if (!instruction) return
    await rewriteRegion(editor, deps, buffer, instruction)
  }, "Run a gptel rewrite from the rewrite transient.")

  editor.command("gptel-rewrite-accept", ({ editor }) => {
    acceptRewrite(editor)
  }, "Accept the last gptel rewrite.")

  editor.command("gptel-rewrite-reject", ({ editor }) => {
    rejectRewrite(editor)
  }, "Reject the last gptel rewrite and restore the original text.")

  editor.command("gptel-abort", ({ editor, buffer }) => {
    const controller = state(editor).activeRequests.get(buffer.id)
    if (!controller) {
      editor.message("gptel: no active request")
      return
    }
    controller.abort()
    editor.message("gptel: aborted")
  }, "Abort the active gptel request for this buffer.")

  editor.command("gptel-regenerate", async ({ editor }) => {
    const last = state(editor).lastRequest
    if (!last) {
      editor.message("gptel: no previous request")
      return
    }
    const buffer = editor.buffers.get(last.bufferId)
    if (!buffer) return
    const currentResponse = buffer.text.slice(last.responseStart, last.responseEnd)
    const priorVariants = [currentResponse, ...last.variants.filter(variant => variant !== currentResponse)]
    replaceWritable(buffer, last.insertionStart, last.insertionEnd, "")
    buffer.point = buffer.text.length
    await sendFromBuffer(editor, deps, buffer, [], priorVariants)
  }, "Regenerate the previous gptel response.")

  editor.command("gptel-previous-variant", ({ editor }) => {
    switchLastVariant(editor, 1)
  }, "Switch the last gptel response to the previous variant.")

  editor.command("gptel-next-variant", ({ editor }) => {
    switchLastVariant(editor, -1)
  }, "Switch the last gptel response to the next variant.")

  editor.command("gptel-beginning-of-response", ({ editor, buffer, args }) => {
    const count = Math.max(1, Number(args[0] ?? 1) || 1)
    for (let i = 0; i < count; i++) moveResponseBoundary(editor, deps, buffer, "start", -1)
  }, "Move point to the beginning of a gptel response.")

  editor.command("gptel-end-of-response", ({ editor, buffer, args }) => {
    const count = Math.max(1, Number(args[0] ?? 1) || 1)
    for (let i = 0; i < count; i++) moveResponseBoundary(editor, deps, buffer, "end", 1)
  }, "Move point to the end of a gptel response.")

  editor.command("gptel-mark-response", ({ editor, buffer }) => {
    markResponse(editor, deps, buffer)
  }, "Mark the gptel response at point.")

  editor.command("gptel-copy-last-response", ({ editor, buffer }) => {
    const response = lastAssistantResponse(buffer, chatMarkers(deps))
    if (!response) {
      editor.message("gptel: no assistant response in this buffer")
      return
    }
    deps.killNew(editor, response)
    editor.message("gptel: copied response to kill ring")
  }, "Copy the last gptel assistant response to the kill ring.")

  editor.command("gptel-preset", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Preset: ", { collection: [...state(editor).presets.keys()], history: "gptel-preset" })
    if (name) await applyPreset(editor, deps, name)
  }, "Apply a gptel preset.")

  editor.command("gptel-system-prompt", ({ editor }) => {
    editor.openTransient(gptelSystemPromptDefinition)
  }, "Open the gptel system prompt transient.")

  editor.command("gptel-system-prompt-set", async ({ editor, args }) => {
    applyTransientArgs(editor, deps, args)
    const directive = positionalArgs(args).find(arg => knownDirectives()[arg])
    const promptFromArgs = transientValue(args, "--system")
    const prompt = directive
      ? knownDirectives()[directive]
      : promptFromArgs ?? await editor.prompt("System prompt: ", deps.getCustom<string>("gptel-system-message") ?? "", "gptel-system")
    if (prompt != null) deps.setCustom("gptel-system-message", prompt)
    editor.message("gptel: system prompt set")
  }, "Set the gptel system prompt.")

  editor.command("gptel-tools", async ({ editor, args }) => {
    const st = state(editor)
    if (!st.tools.size) {
      editor.message("gptel: no tools registered")
      return
    }
    if (!args.length) {
      editor.openTransient(gptelToolsDefinition(editor, deps))
      return
    }
    const current = deps.getCustom<string>("gptel-tools") ?? ""
    const value = args.join(" ") || await editor.prompt("Tools (comma/space separated): ", current, "gptel-tools")
    if (value != null) deps.setCustom("gptel-tools", value)
    editor.message(`gptel tools: ${deps.getCustom<string>("gptel-tools") || "(none)"}`)
  }, "Set active gptel tools by name.")

  editor.command("gptel-tools-apply", ({ editor, args }) => {
    const selected: string[] = []
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!
      if (arg === "--use-tools") deps.setCustom("gptel-use-tools", true)
      else if (arg === "--confirm-tools") deps.setCustom("gptel-confirm-tool-calls", true)
      else if (arg === "--include-tool-results") {
        const value = args[++i]
        if (value != null) deps.setCustom("gptel-include-tool-results", value)
      } else if (arg.startsWith("--tool=")) {
        selected.push(arg.slice("--tool=".length))
      }
    }
    deps.setCustom("gptel-tools", selected.join(","))
    editor.message(`gptel tools: ${selected.join(", ") || "(none)"}`)
  }, "Apply active tools from the gptel tools transient.")

  editor.command("gptel-openai-oauth-login", async ({ editor, args }) => {
    const token = args.join(" ") || await editor.prompt("OpenAI OAuth token: ", "", "gptel-openai-oauth-token")
    if (!token) return
    await writeTokenFile(emacsCachePath("gptel-openai", "openai-oauth-token"), token.trim())
    editor.message("gptel: saved OpenAI OAuth token")
  }, "Save an OpenAI OAuth token for gptel OpenAI OAuth backends.")

  editor.command("gptel-gh-login", async ({ editor, args }) => {
    const token = args.join(" ") || await editor.prompt("GitHub Copilot chat token: ", "", "gptel-gh-token")
    if (!token) return
    await writeTokenFile(emacsCachePath("copilot-chat", "token"), token.trim())
    editor.message("gptel: saved GitHub Copilot token")
  }, "Save a GitHub Copilot chat token for gptel Copilot backends.")

  editor.command("gptel-version", ({ editor }) => {
    editor.message("gptel.ts 0.9.9.5-compatible")
  }, "Show the gptel.ts compatibility version.")

  editor.command("gptel-inspect", ({ editor }) => {
    editor.scratch("*gptel*", describeState(editor, deps), "text")
  }, "Inspect gptel state.")

  editor.defineKey("global", "s-m", "gptel-menu")
  editor.defineKey("global", "s-g", "gptel")
}
