import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { homedir } from "node:os"
import type { BufferModel } from "../../jemacs-opentui/src/kernel/buffer"
import type { Editor, TransientDefinition } from "../../jemacs-opentui/src/kernel/editor"
import type { TextSpan } from "../../jemacs-opentui/src/kernel/extension-points"

type GptelDeps = {
  Keymap: typeof import("../../jemacs-opentui/src/kernel/keymap").Keymap
  defineMode: typeof import("../../jemacs-opentui/src/modes/mode").defineMode
  defineMinorMode: typeof import("../../jemacs-opentui/src/modes/minor-mode").defineMinorMode
  defcustom: typeof import("../../jemacs-opentui/src/runtime/custom").defcustom
  getCustom: typeof import("../../jemacs-opentui/src/runtime/custom").getCustom
  setCustom: typeof import("../../jemacs-opentui/src/runtime/custom").setCustom
  getCustomVariable: typeof import("../../jemacs-opentui/src/runtime/custom").getCustomVariable
  defface: typeof import("../../jemacs-opentui/src/runtime/faces").defface
  killNew: typeof import("../../jemacs-opentui/src/runtime/kill-ring").killNew
  currentKill: typeof import("../../jemacs-opentui/src/runtime/kill-ring").currentKill
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
  | { type: "region"; name: string; bufferId: string; start: number; end: number; text: string; lineStart?: number; lineEnd?: number }
  | { type: "file"; path: string; text: string; binary?: boolean; mime?: string }
  | { type: "directory"; path: string; files: Array<{ path: string; text: string }> }
  | { type: "text"; name: string; text: string }

export type GptelContextAlistEntry =
  | { source: "buffer"; bufferId: string; name: string; regions?: Array<{ start: number; end: number; snapshot: string; lineStart?: number; lineEnd?: number }>; full?: boolean }
  | { source: "file"; path: string; mime?: string }
  | { source: "text"; name: string; text: string }

export type GptelContextStringFunction = (items: readonly GptelContextItem[], editor?: Editor, buffer?: BufferModel) => string
export type GptelContextWrapFunction = (context: string, prompt: string, method?: string | boolean) => string

export type GptelTool = {
  name: string
  description: string
  parameters?: unknown
  confirm?: boolean
  include?: boolean
  async?: boolean
  category?: string
  sourceName?: string
  function: (...args: any[]) => unknown | Promise<unknown> | void
}

export type GptelMcpToolSpec = {
  name: string
  description?: string
  parameters?: unknown
  confirm?: boolean
  include?: boolean
  async?: boolean
  function?: (args: unknown, ctx: { editor: Editor; buffer: BufferModel }) => unknown | Promise<unknown>
}

export type GptelMcpServer = {
  name: string
  status?: "connected" | "disconnected"
  tools?: GptelMcpToolSpec[]
  connect?: () => void | Promise<void>
  disconnect?: () => void | Promise<void>
}

export type GptelToolCall = {
  id: string
  name: string
  arguments: unknown
  confirm?: boolean
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

export type GptelPresetValueSpec<T = unknown> = T | {
  append?: unknown
  prepend?: unknown
  remove?: unknown
  merge?: Record<string, unknown>
  eval?: (() => unknown) | unknown
  function?: (current: unknown) => unknown
}

export type GptelPreset = {
  name: string
  description?: string
  parents?: string | string[] | GptelPreset | GptelPreset[]
  pre?: () => void | Promise<void>
  post?: () => void | Promise<void>
  backend?: GptelPresetValueSpec<string | GptelBackend>
  model?: GptelPresetValueSpec<string>
  system?: GptelPresetValueSpec<string>
  "system-prompt"?: GptelPresetValueSpec<string>
  "system-message"?: GptelPresetValueSpec<string>
  stream?: GptelPresetValueSpec<boolean>
  temperature?: GptelPresetValueSpec<number | null>
  "max-tokens"?: GptelPresetValueSpec<number | null>
  maxTokens?: GptelPresetValueSpec<number | null>
  "use-context"?: GptelPresetValueSpec<string | boolean>
  useContext?: GptelPresetValueSpec<string | boolean>
  "track-media"?: GptelPresetValueSpec<boolean>
  trackMedia?: GptelPresetValueSpec<boolean>
  "include-reasoning"?: GptelPresetValueSpec<string | boolean>
  includeReasoning?: GptelPresetValueSpec<string | boolean>
  "use-tools"?: GptelPresetValueSpec<boolean>
  useTools?: GptelPresetValueSpec<boolean>
  tools?: GptelPresetValueSpec<string | string[] | GptelTool[]>
  "confirm-tool-calls"?: GptelPresetValueSpec<boolean | string>
  confirmToolCalls?: GptelPresetValueSpec<boolean | string>
  schema?: GptelPresetValueSpec<unknown>
  "rewrite-directive"?: GptelPresetValueSpec<string>
  rewriteDirective?: GptelPresetValueSpec<string>
  [key: string]: unknown
}

export type GptelDirective = {
  name: string
  prompt: string | (() => string)
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
export type GptelPreToolCallResult = GptelToolCall | false | true | void | {
  name?: string
  args?: unknown
  arguments?: unknown
  confirm?: boolean
  block?: boolean | string
  stop?: boolean
  result?: unknown
}
export type GptelPostToolCallResult = GptelMessage | void | {
  result?: unknown
  block?: boolean | string
  stop?: boolean
}
export type GptelPreToolCallFunction = (call: GptelToolCall, tool: GptelTool | undefined, ctx: GptelRequestContext) => GptelPreToolCallResult | Promise<GptelPreToolCallResult>
export type GptelPostToolCallFunction = (call: GptelToolCall, result: GptelMessage, tool: GptelTool | undefined, ctx: GptelRequestContext) => GptelPostToolCallResult | Promise<GptelPostToolCallResult>
export type GptelRewriteDirectivesHook = (ctx: { editor: Editor; buffer: BufferModel }) => string | null | undefined

type PendingToolCallState = {
  bufferId: string
  calls: GptelToolCall[]
  resolve: (decision: "accept" | "reject") => void
}

type GptelResponseHistory = {
  bufferId: string
  start: number
  end: number
  variants: string[]
  variantIndex: number
}

type GptelPendingRewrite = {
  id: string
  bufferId: string
  start: number
  end: number
  original: string
  replacement: string
  instruction: string
}

type GptelState = {
  backends: Map<string, GptelBackend>
  tools: Map<string, GptelTool>
  mcpServers: Map<string, GptelMcpServer>
  presets: Map<string, GptelPreset>
  directives: Map<string, string | (() => string)>
  promptTransforms: GptelPromptTransform[]
  responseFilters: GptelResponseFilter[]
  postResponseFunctions: GptelPostResponseFunction[]
  preToolCallFunctions: GptelPreToolCallFunction[]
  postToolCallFunctions: GptelPostToolCallFunction[]
  rewriteDirectivesHooks: GptelRewriteDirectivesHook[]
  context: GptelContextItem[]
  gptelContextAlist: GptelContextAlistEntry[]
  activeRequests: Map<string, AbortController>
  requestFsms: GptelRequestFsm[]
  crowdsourcedPrompts: Map<string, string>
  crowdsourcedPromptsFile?: string
  pendingToolCalls?: PendingToolCallState
  tokenUsage: GptelTokenUsage
  responseHistories: GptelResponseHistory[]
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
  rewriteOverlays: GptelPendingRewrite[]
  lastRewrite?: GptelPendingRewrite
}

type GptelRequestFsmState = "INIT" | "WAIT" | "TYPE" | "TOOL" | "DONE" | "ERRS"

type GptelRequestFsmTransition = {
  state: GptelRequestFsmState
  at: string
  note?: string
}

type GptelRequestFsm = {
  id: string
  bufferId: string
  backend: string
  model: string
  state: GptelRequestFsmState
  active: boolean
  editor: Editor
  deps: GptelDeps
  toolResults?: boolean
  payload?: GptelRequestPayload
  history: GptelRequestFsmTransition[]
}

type GptelInspectQueryMeta = {
  originBufferId: string
  insertionPosition: number
  backend: string
  model: string
  payload: GptelRequestPayload
  format: "json" | "object"
}

type RequestResult = {
  text: string
  raw?: unknown
  usage?: GptelTokenUsage
  toolCalls?: GptelToolCall[]
}

type GptelRequestPayload = {
  url: string
  headers: Record<string, string>
  body: unknown
  stream: boolean
}

const STATE_KEY = "gptel-state"
const GPTEL_MODE = "gptel-mode"
const GPTEL_CHAT_MODE = "gptel-chat"
const GPTEL_CONTEXT_MODE = "gptel-context"
const GPTEL_QUERY_MODE = "gptel-query"
const GPTEL_QUERY_MINOR_MODE = "gptel-query-mode"
const GPTEL_BUFFER_PREFIX = "*ChatGPT*"
const CONTEXT_SECTIONS = "gptel-context-sections"
const CONTEXT_FLAGGED = "gptel-context-flagged"
const CONTEXT_LOCAL = "gptel-context"
const CONTEXT_TRACKERS = "gptel-context-trackers"
const CONTEXT_TRACKING_PREVIOUS = "gptel-context-on-splice-previous"
const STATE_BLOCK_START = "<!-- gptel-state:"
const STATE_BLOCK_END = "-->"
const STATE_RESTORED = "gptel-state-restored"
const INSPECT_QUERY_META = "gptel-inspect-query-meta"
const STATUS_LOCAL = "gptel-status"
const HIGHLIGHT_COMMENT_LOCAL = "gptel-highlight-comment-shown"
const DEFAULT_SYSTEM_MESSAGE = "You are a helpful assistant."
const CROWDSOURCED_PROMPTS_URL = "https://raw.githubusercontent.com/f/prompts.chat/main/prompts.csv"
type GptelContextSection = {
  index: number
  start: number
  end: number
}

type GptelSavedState = {
  backend?: string
  model?: string
  system?: string
  tools?: string
  temperature?: number
  maxTokens?: number
  numMessagesToSend?: number | null
  useContext?: string | boolean
  includeReasoning?: string | boolean
  schema?: string
  responseRanges?: Array<{ start: number; end: number }>
  responseHistories?: Array<{
    start: number
    end: number
    variants: string[]
    variantIndex: number
  }>
  lastRequest?: {
    responseStart: number
    responseEnd: number
    variants: string[]
    variantIndex: number
  }
}

type OrgHeading = {
  start: number
  end: number
  level: number
  title: string
  contentStart: number
}

type GptelPrefixAlist = Record<string, string> | Array<[string, string]> | string

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
    getCustomVariable: custom.getCustomVariable,
    defface: faces.defface,
    killNew: killRing.killNew,
    currentKill: killRing.currentKill,
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
    mcpServers: new Map(),
    presets: new Map(),
    directives: new Map(Object.entries(defaultDirectives())),
    promptTransforms: [],
    responseFilters: [],
    postResponseFunctions: [],
    preToolCallFunctions: [],
    postToolCallFunctions: [],
    rewriteDirectivesHooks: [],
    context: [],
    gptelContextAlist: [],
    activeRequests: new Map(),
    requestFsms: [],
    crowdsourcedPrompts: new Map(),
    tokenUsage: {},
    responseHistories: [],
    rewriteOverlays: [],
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

function customString(deps: Pick<GptelDeps, "getCustom">, ...names: string[]): string {
  for (const name of names) {
    const value = deps.getCustom<string | (() => string)>(name)
    const resolved = typeof value === "function" ? value() : value
    if (resolved) return resolved
  }
  return ""
}

function systemMessage(deps: Pick<GptelDeps, "getCustom">): string {
  const promptValue = deps.getCustom<string | null | (() => string | null)>("gptel-system-prompt")
  if (promptValue === null) return ""
  const prompt = typeof promptValue === "function" ? promptValue() ?? "" : promptValue
  const messageValue = deps.getCustom<string | null | (() => string | null)>("gptel-system-message")
  const message = typeof messageValue === "function" ? messageValue() ?? "" : messageValue
  if (prompt && prompt !== DEFAULT_SYSTEM_MESSAGE && (!message || message === DEFAULT_SYSTEM_MESSAGE)) return prompt
  return message || prompt || DEFAULT_SYSTEM_MESSAGE
}

function setSystemMessage(deps: Pick<GptelDeps, "setCustom">, value: string): void {
  deps.setCustom("gptel-system-prompt", value)
  deps.setCustom("gptel-system-message", value)
}

function backendKey(backend: GptelBackend, deps?: Pick<GptelDeps, "getCustom">): string {
  if (typeof backend.key === "function") return backend.key()
  if (backend.key) return backend.key
  if (backend.keyEnv) return process.env[backend.keyEnv] ?? ""
  if (deps) return customString(deps, "gptel-api-key")
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

function isLikelyBinaryFile(path: string, size = statSync(path).size): boolean {
  if (size > 200_000) return true
  const mime = mimeTypeForPath(path)
  if (mime && !isTextMime(mime)) return true
  try {
    const sample = readFileSync(path).subarray(0, Math.min(size, 4096))
    if (sample.includes(0)) return true
    let suspicious = 0
    for (const byte of sample) {
      if (byte < 7 || (byte > 13 && byte < 32)) suspicious++
    }
    return sample.length > 0 && suspicious / sample.length > 0.3
  } catch {
    return true
  }
}

function base64File(path: string): string | null {
  try { return readFileSync(path).toString("base64") } catch { return null }
}

export function mediaPartsFromContext(items: readonly GptelContextItem[]): GptelMediaPart[] {
  const media: GptelMediaPart[] = []
  for (const item of flattenContextItems(items)) {
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

function lineNumberAt(buffer: BufferModel, offset: number): number {
  return buffer.lineAt(Math.max(0, Math.min(offset, buffer.text.length))) + 1
}

function modeFence(buffer: BufferModel): string {
  return buffer.mode.replace(/-mode$/, "")
}

function contextItemText(item: GptelContextItem, editor?: Editor): string {
  if (item.type === "buffer") return editor?.buffers.get(item.bufferId)?.text ?? item.text
  if (item.type === "region") {
    const source = editor?.buffers.get(item.bufferId)
    if (source) return source.text.slice(item.start, item.end)
    return item.text
  }
  if (item.type === "file") {
    if (item.binary) return ""
    try { return readFileSync(item.path, "utf8") } catch { return item.text }
  }
  if (item.type === "directory") return item.files.map(file => file.text).join("\n\n")
  return item.text
}

function flattenContextItems(items: readonly GptelContextItem[]): GptelContextItem[] {
  const flat: GptelContextItem[] = []
  for (const item of items) {
    if (item.type === "directory") {
      for (const file of item.files) flat.push({ type: "file", path: file.path, text: file.text })
    } else flat.push(item)
  }
  return flat
}

function defaultChatMarkers(): GptelChatMarkers {
  return { promptPrefix: "User:\n", responsePrefix: "Assistant:\n", separator: "\n\n" }
}

function defaultPromptPrefixAlist(): Record<string, string> {
  return { "markdown-mode": "### ", markdown: "### ", "org-mode": "*** ", "text-mode": "### ", text: "### " }
}

function defaultResponsePrefixAlist(): Record<string, string> {
  return { "markdown-mode": "", markdown: "", "org-mode": "", "text-mode": "", text: "" }
}

function normalizePrefixAlist(value: GptelPrefixAlist | undefined, fallback: Record<string, string>): Record<string, string> {
  if (!value) return fallback
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown
      return normalizePrefixAlist(parsed as GptelPrefixAlist, fallback)
    } catch {
      return fallback
    }
  }
  if (Array.isArray(value)) return { ...fallback, ...Object.fromEntries(value.filter(entry => typeof entry[0] === "string" && typeof entry[1] === "string")) }
  return { ...fallback, ...Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) }
}

function modePrefix(deps: Pick<GptelDeps, "getCustom">, name: "gptel-prompt-prefix-alist" | "gptel-response-prefix-alist", mode: string, fallback: Record<string, string>): string {
  const alist = normalizePrefixAlist(deps.getCustom<GptelPrefixAlist>(name), fallback)
  const key = mode === GPTEL_CHAT_MODE ? "markdown" : mode
  return alist[key] ?? alist[key.replace(/-mode$/, "")] ?? ""
}

function chatMarkers(deps: GptelDeps, buffer?: BufferModel): GptelChatMarkers {
  const defaults = defaultChatMarkers()
  const mode = buffer?.mode ?? String(deps.getCustom<string>("gptel-default-mode") ?? "markdown")
  if (mode === GPTEL_CHAT_MODE
    && deps.getCustom<string | null>("gptel-prompt-prefix") == null
    && deps.getCustom<string | null>("gptel-response-prefix") == null) {
    return { ...defaults, separator: deps.getCustom<string>("gptel-response-separator") ?? defaults.separator }
  }
  return {
    promptPrefix: deps.getCustom<string | null>("gptel-prompt-prefix") ?? modePrefix(deps, "gptel-prompt-prefix-alist", mode, defaultPromptPrefixAlist()),
    responsePrefix: deps.getCustom<string | null>("gptel-response-prefix") ?? modePrefix(deps, "gptel-response-prefix-alist", mode, defaultResponsePrefixAlist()),
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

function stripStateBlocks(text: string): string {
  return text.replace(stateBlockRegex(), "").trim()
}

export function extractPrompt(buffer: BufferModel, markers: GptelChatMarkers = defaultChatMarkers()): { prompt: string; start: number; end: number } {
  const bounds = regionBounds(buffer)
  if (bounds) return { prompt: stripStateBlocks(buffer.text.slice(bounds[0], bounds[1])), start: bounds[0], end: bounds[1] }
  if (buffer.mode === GPTEL_CHAT_MODE || buffer.minorModes.has(GPTEL_MODE)) {
    const beforePoint = buffer.text.slice(0, buffer.point)
    const user = Math.max(beforePoint.lastIndexOf(markerText(markers, "user", true)), beforePoint.lastIndexOf(markerText(markers, "user")))
    const assistant = Math.max(beforePoint.lastIndexOf(markerText(markers, "assistant", true)), beforePoint.lastIndexOf(markerText(markers, "assistant")))
    const start = user >= 0 && user > assistant
      ? user + (beforePoint.startsWith(markerText(markers, "user", true), user) ? markerText(markers, "user", true).length : markerText(markers, "user").length)
      : 0
    return { prompt: stripStateBlocks(beforePoint.slice(start)), start, end: buffer.point }
  }
  return { prompt: stripStateBlocks(buffer.text.slice(0, buffer.point)), start: 0, end: buffer.point }
}

export function gptelContextString(items: readonly GptelContextItem[], editor?: Editor): string {
  const parts: string[] = []
  for (const item of flattenContextItems(items)) {
    if (item.type === "buffer") {
      const source = editor?.buffers.get(item.bufferId)
      parts.push(`In buffer \`${item.name}\`:\n\n\`\`\`${source ? modeFence(source) : ""}\n${contextItemText(item, editor)}\n\`\`\``)
    } else if (item.type === "region") {
      const source = editor?.buffers.get(item.bufferId)
      const lineStart = source ? lineNumberAt(source, item.start) : item.lineStart
      const lineEnd = source ? lineNumberAt(source, item.end) : item.lineEnd
      const lineSuffix = lineStart != null && lineEnd != null ? ` (lines ${lineStart}-${lineEnd})` : ""
      parts.push(`In buffer \`${item.name}\`${lineSuffix}:\n\n\`\`\`${source ? modeFence(source) : ""}\n${contextItemText(item, editor)}\n\`\`\``)
    } else if (item.type === "file") {
      if (item.mime && !isTextMime(item.mime)) continue
      parts.push(`In file \`${item.path}\`:\n\n\`\`\`\n${contextItemText(item, editor)}\n\`\`\``)
    } else if (item.type === "text") {
      parts.push(`In ${item.name}:\n\n\`\`\`\n${item.text}\n\`\`\``)
    }
  }
  return parts.length ? `Request context:\n\n${parts.join("\n\n")}` : ""
}

export function gptelContextWrapDefault(context: string, prompt: string, method: string | boolean = "user"): string {
  if (!context.trim()) return prompt
  if (method === "system") return `${context}\n\n${prompt}`
  return `${context}\n\nIn addition to the request context above, respond to the following user request:\n\n${prompt}`
}

export function renderContext(items: readonly GptelContextItem[]): string {
  return gptelContextString(items)
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

function bufferLocalContext(buffer: BufferModel): GptelContextItem[] {
  const existing = buffer.locals.get(CONTEXT_LOCAL) as GptelContextItem[] | undefined
  if (existing) return existing
  const next: GptelContextItem[] = []
  buffer.locals.set(CONTEXT_LOCAL, next)
  return next
}

function adjustTrackedPosition(pos: number, from: number, to: number, insertedLength: number, stickToEnd = false): number {
  const removedLength = to - from
  if (pos < from || (pos === from && !stickToEnd)) return pos
  if (pos > to || (pos === to && stickToEnd)) return pos + insertedLength - removedLength
  return stickToEnd ? from + insertedLength : from
}

function ensureContextTracking(buffer: BufferModel): void {
  if (buffer.locals.has(CONTEXT_TRACKERS)) return
  buffer.locals.set(CONTEXT_TRACKERS, true)
  const previous = buffer.onSplice
  buffer.locals.set(CONTEXT_TRACKING_PREVIOUS, previous)
  buffer.onSplice = (splice, opts) => {
    previous?.(splice, opts)
    const items = bufferLocalContext(buffer)
    for (const item of items) {
      if (item.type !== "region") continue
      item.start = adjustTrackedPosition(item.start, splice.from, splice.to, splice.text.length, false)
      item.end = adjustTrackedPosition(item.end, splice.from, splice.to, splice.text.length, true)
      item.lineStart = lineNumberAt(buffer, item.start)
      item.lineEnd = lineNumberAt(buffer, item.end)
    }
  }
}

function addBufferContextItem(editor: Editor, buffer: BufferModel, full = true): GptelContextItem {
  const item: GptelContextItem = { type: "buffer", name: editor.bufferDisplayName(buffer), bufferId: buffer.id, text: buffer.text }
  state(editor).context.push(item)
  bufferLocalContext(buffer).push(item)
  state(editor).gptelContextAlist.push({ source: "buffer", bufferId: buffer.id, name: item.name, full: true })
  return item
}

function addRegionContextItem(editor: Editor, buffer: BufferModel, start: number, end: number): GptelContextItem {
  ensureContextTracking(buffer)
  removeBufferContextInRange(editor, buffer, start, end, false)
  const item: GptelContextItem = {
    type: "region",
    name: editor.bufferDisplayName(buffer),
    bufferId: buffer.id,
    start,
    end,
    text: buffer.text.slice(start, end),
    lineStart: lineNumberAt(buffer, start),
    lineEnd: lineNumberAt(buffer, end),
  }
  state(editor).context.push(item)
  bufferLocalContext(buffer).push(item)
  state(editor).gptelContextAlist.push({
    source: "buffer",
    bufferId: buffer.id,
    name: item.name,
    regions: [{ start, end, snapshot: item.text, lineStart: item.lineStart, lineEnd: item.lineEnd }],
  })
  return item
}

function removeBufferContextInRange(editor: Editor, buffer: BufferModel, start = 0, end = buffer.text.length, message = true): number {
  const overlaps = (item: GptelContextItem) =>
    ("bufferId" in item) && item.bufferId === buffer.id &&
    (item.type === "buffer" || (item.type === "region" && item.start < end && item.end > start))
  const st = state(editor)
  const before = st.context.length
  st.context = st.context.filter(item => !overlaps(item))
  const local = bufferLocalContext(buffer)
  const kept = local.filter(item => !overlaps(item))
  local.splice(0, local.length, ...kept)
  st.gptelContextAlist = st.gptelContextAlist.filter(entry => !(entry.source === "buffer" && entry.bufferId === buffer.id))
  const removed = before - st.context.length
  if (message) editor.message(`${removed} context${removed === 1 ? "" : "s"} removed from current buffer.`)
  return removed
}

function removeContextItem(editor: Editor, item: GptelContextItem): void {
  const st = state(editor)
  st.context = st.context.filter(existing => existing !== item)
  if ("bufferId" in item) {
    const buffer = editor.buffers.get(item.bufferId)
    if (buffer) {
      const local = bufferLocalContext(buffer)
      const index = local.indexOf(item)
      if (index >= 0) local.splice(index, 1)
    }
    st.gptelContextAlist = st.gptelContextAlist.filter(entry => !(entry.source === "buffer" && entry.bufferId === item.bufferId))
  } else if (item.type === "file") {
    st.gptelContextAlist = st.gptelContextAlist.filter(entry => !(entry.source === "file" && entry.path === item.path))
  }
}

function contextItemsForRequest(editor: Editor, _buffer?: BufferModel): GptelContextItem[] {
  const seen = new Set<GptelContextItem>()
  const items: GptelContextItem[] = []
  for (const item of state(editor).context) {
    if (!seen.has(item)) {
      seen.add(item)
      items.push(item)
    }
  }
  for (const buffer of editor.buffers.values()) {
    for (const item of bufferLocalContext(buffer)) {
      if (!seen.has(item)) {
        seen.add(item)
        items.push(item)
      }
    }
  }
  return items
}

function addCurrentKillContext(editor: Editor, deps: GptelDeps, accumulate: boolean): void {
  const kill = deps.currentKill(editor, 0)
  if (!kill) {
    editor.message("gptel: kill ring is empty")
    return
  }
  const existing = state(editor).context.find(item => item.type === "text" && item.name === "*current-kill*") as Extract<GptelContextItem, { type: "text" }> | undefined
  if (accumulate && existing) existing.text = `${existing.text}\n----\n${kill}`
  else if (existing) existing.text = kill
  else state(editor).context.push({ type: "text", name: "*current-kill*", text: kill })
  editor.message("*current-kill* has been added as context.")
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
  const stateBlock = buffer.text.match(stateBlockRegex())
  // The persisted gptel-state comment block is metadata, never response text.
  const limit = stateBlock?.index != null
    ? buffer.text.slice(0, stateBlock.index).replace(/\s+$/, "").length
    : buffer.text.length
  for (const match of buffer.text.matchAll(regex)) {
    const full = match[0] ?? ""
    const body = match[1] ?? ""
    const end = (match.index ?? 0) + full.length
    const start = end - body.length
    if (start >= limit) continue
    ranges.push({ start, end: Math.min(end, limit) })
  }
  return ranges
}

function responseRangeAtPoint(buffer: BufferModel, markers: GptelChatMarkers): { start: number; end: number } | null {
  return responseRanges(buffer, markers).find(range => buffer.point >= range.start && buffer.point <= range.end) ?? null
}

function responseHistoryText(buffer: BufferModel, history: GptelResponseHistory): string {
  return buffer.text.slice(history.start, history.end)
}

function normalizeResponseHistory(buffer: BufferModel, history: GptelResponseHistory): GptelResponseHistory {
  const current = responseHistoryText(buffer, history)
  const variants = [current, ...history.variants.filter(variant => variant !== current)]
  const variantIndex = Math.max(0, variants.indexOf(history.variants[history.variantIndex] ?? current))
  return { ...history, variants, variantIndex: variantIndex < 0 ? 0 : variantIndex }
}

function reconcileResponseHistories(editor: Editor, deps: GptelDeps, buffer: BufferModel): GptelResponseHistory[] {
  const st = state(editor)
  const ranges = responseRanges(buffer, chatMarkers(deps, buffer))
  const existing = st.responseHistories.filter(history => history.bufferId === buffer.id)
  const byExact = new Map(existing.map(history => [`${history.start}:${history.end}`, history]))
  const used = new Set<GptelResponseHistory>()
  const reconciled: GptelResponseHistory[] = []
  for (const range of ranges) {
    let history = byExact.get(`${range.start}:${range.end}`)
    if (!history) {
      history = existing.find(candidate =>
        !used.has(candidate)
        && candidate.start <= range.end
        && candidate.end >= range.start
        && buffer.text.slice(range.start, range.end) === candidate.variants[candidate.variantIndex])
    }
    if (history) {
      used.add(history)
      reconciled.push(normalizeResponseHistory(buffer, { ...history, start: range.start, end: range.end }))
    }
  }
  st.responseHistories = [
    ...st.responseHistories.filter(history => history.bufferId !== buffer.id),
    ...reconciled,
  ]
  return reconciled
}

function upsertResponseHistory(editor: Editor, buffer: BufferModel, history: GptelResponseHistory): GptelResponseHistory {
  const st = state(editor)
  const normalized = normalizeResponseHistory(buffer, history)
  const index = st.responseHistories.findIndex(item =>
    item.bufferId === buffer.id && item.start === history.start && item.end === history.end)
  if (index >= 0) st.responseHistories[index] = normalized
  else st.responseHistories.push(normalized)
  return normalized
}

function responseHistoryAtPoint(editor: Editor, deps: GptelDeps, buffer: BufferModel): GptelResponseHistory | null {
  const range = responseRangeAtPoint(buffer, chatMarkers(deps, buffer))
  if (!range) return null
  const histories = reconcileResponseHistories(editor, deps, buffer)
  return histories.find(history => history.start === range.start && history.end === range.end)
    ?? upsertResponseHistory(editor, buffer, {
      bufferId: buffer.id,
      start: range.start,
      end: range.end,
      variants: [buffer.text.slice(range.start, range.end)],
      variantIndex: 0,
    })
}

function stateBlockRegex(): RegExp {
  return new RegExp(`${escapeRegExp(STATE_BLOCK_START)}\\n[\\s\\S]*?\\n${escapeRegExp(STATE_BLOCK_END)}\\n?`, "m")
}

function parseSavedState(buffer: BufferModel): GptelSavedState | null {
  const match = buffer.text.match(stateBlockRegex())
  if (!match) return null
  const json = match[0]
    .replace(STATE_BLOCK_START, "")
    .replace(STATE_BLOCK_END, "")
    .trim()
  try {
    return JSON.parse(json) as GptelSavedState
  } catch {
    return null
  }
}

function savedStatePayload(editor: Editor, deps: GptelDeps, buffer: BufferModel): GptelSavedState {
  const last = state(editor).lastRequest
  if (last?.bufferId === buffer.id) {
    upsertResponseHistory(editor, buffer, {
      bufferId: buffer.id,
      start: last.responseStart,
      end: last.responseEnd,
      variants: last.variants,
      variantIndex: last.variantIndex,
    })
  }
  const histories = reconcileResponseHistories(editor, deps, buffer)
  return {
    backend: deps.getCustom<string>("gptel-backend"),
    model: deps.getCustom<string>("gptel-model"),
    system: systemMessage(deps),
    tools: deps.getCustom<string>("gptel-tools"),
    temperature: deps.getCustom<number | null>("gptel-temperature") ?? undefined,
    maxTokens: deps.getCustom<number | null>("gptel-max-tokens") ?? undefined,
    numMessagesToSend: deps.getCustom<number | null>("gptel-num-messages-to-send") ?? null,
    useContext: deps.getCustom<string | boolean>("gptel-use-context"),
    includeReasoning: deps.getCustom<string | boolean>("gptel-include-reasoning"),
    schema: deps.getCustom<string>("gptel-schema"),
    responseRanges: responseRanges(buffer, chatMarkers(deps, buffer)),
    responseHistories: histories.map(history => ({
      start: history.start,
      end: history.end,
      variants: history.variants,
      variantIndex: history.variantIndex,
    })),
    lastRequest: last?.bufferId === buffer.id ? {
      responseStart: last.responseStart,
      responseEnd: last.responseEnd,
      variants: last.variants,
      variantIndex: last.variantIndex,
    } : undefined,
  }
}

async function saveGptelState(editor: Editor, deps: GptelDeps, buffer: BufferModel): Promise<void> {
  await editor.runHook("gptel-save-state-hook", buffer)
  const block = `${STATE_BLOCK_START}\n${JSON.stringify(savedStatePayload(editor, deps, buffer), null, 2)}\n${STATE_BLOCK_END}\n`
  const match = buffer.text.match(stateBlockRegex())
  if (match?.index != null) replaceWritable(buffer, match.index, match.index + match[0].length, block)
  else appendWritable(buffer, `${buffer.text.endsWith("\n") ? "" : "\n"}${block}`)
  buffer.locals.set(STATE_RESTORED, true)
}

function restoreGptelState(editor: Editor, deps: GptelDeps, buffer: BufferModel): boolean {
  const saved = parseSavedState(buffer)
  if (!saved) return false
  if (saved.backend) deps.setCustom("gptel-backend", saved.backend)
  if (saved.model) deps.setCustom("gptel-model", saved.model)
  if (saved.system) setSystemMessage(deps, saved.system)
  if (saved.tools != null) deps.setCustom("gptel-tools", saved.tools)
  if (typeof saved.temperature === "number") deps.setCustom("gptel-temperature", saved.temperature)
  if (typeof saved.maxTokens === "number") deps.setCustom("gptel-max-tokens", saved.maxTokens)
  if (saved.numMessagesToSend !== undefined) deps.setCustom("gptel-num-messages-to-send", saved.numMessagesToSend)
  if (saved.useContext != null) deps.setCustom("gptel-use-context", saved.useContext)
  if (saved.includeReasoning != null) deps.setCustom("gptel-include-reasoning", saved.includeReasoning)
  if (saved.schema != null) deps.setCustom("gptel-schema", saved.schema)
  if (saved.lastRequest) {
    state(editor).lastRequest = {
      bufferId: buffer.id,
      prompt: "",
      messages: [],
      insertionStart: saved.lastRequest.responseStart,
      responseStart: saved.lastRequest.responseStart,
      responseEnd: saved.lastRequest.responseEnd,
      insertionEnd: saved.lastRequest.responseEnd,
      backend: saved.backend ?? deps.getCustom<string>("gptel-backend") ?? "",
      model: saved.model ?? deps.getCustom<string>("gptel-model") ?? "",
      variants: saved.lastRequest.variants,
      variantIndex: saved.lastRequest.variantIndex,
    }
  }
  const restoredHistories = (saved.responseHistories ?? [])
    .filter(history => Number.isFinite(history.start) && Number.isFinite(history.end) && Array.isArray(history.variants))
    .map(history => normalizeResponseHistory(buffer, {
      bufferId: buffer.id,
      start: history.start,
      end: history.end,
      variants: history.variants,
      variantIndex: history.variantIndex,
    }))
  if (restoredHistories.length) {
    const st = state(editor)
    st.responseHistories = [
      ...st.responseHistories.filter(history => history.bufferId !== buffer.id),
      ...restoredHistories,
    ]
  } else if (saved.lastRequest) {
    upsertResponseHistory(editor, buffer, {
      bufferId: buffer.id,
      start: saved.lastRequest.responseStart,
      end: saved.lastRequest.responseEnd,
      variants: saved.lastRequest.variants,
      variantIndex: saved.lastRequest.variantIndex,
    })
  }
  buffer.locals.set(STATE_RESTORED, true)
  return true
}

function restoreGptelStateOnce(editor: Editor, deps: GptelDeps, buffer: BufferModel): void {
  if (buffer.locals.get(STATE_RESTORED)) return
  if (!restoreOrgGptelProperties(editor, deps, buffer)) restoreGptelState(editor, deps, buffer)
}

function orgHeadings(buffer: BufferModel): OrgHeading[] {
  const headings: OrgHeading[] = []
  const regex = /^(\*+)\s+(.+)$/gm
  for (const match of buffer.text.matchAll(regex)) {
    const start = match.index ?? 0
    const lineEnd = buffer.text.indexOf("\n", start)
    headings.push({
      start,
      end: buffer.text.length,
      level: match[1]!.length,
      title: match[2]!.trim(),
      contentStart: lineEnd < 0 ? buffer.text.length : lineEnd + 1,
    })
  }
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]!
    const next = headings.slice(i + 1).find(candidate => candidate.level <= heading.level)
    heading.end = next?.start ?? buffer.text.length
  }
  return headings
}

function orgHeadingAt(buffer: BufferModel, point = buffer.point): OrgHeading | null {
  return orgHeadings(buffer)
    .filter(heading => point >= heading.start && point <= heading.end)
    .sort((a, b) => b.level - a.level)[0] ?? null
}

function orgPropertyDrawerBounds(buffer: BufferModel, heading: OrgHeading): { start: number; end: number } | null {
  const text = buffer.text.slice(heading.contentStart, heading.end)
  const match = text.match(/^:PROPERTIES:\n[\s\S]*?^:END:\n?/m)
  if (!match || match.index == null) return null
  return { start: heading.contentStart + match.index, end: heading.contentStart + match.index + match[0].length }
}

function orgPropertiesAt(buffer: BufferModel, heading: OrgHeading | null): Record<string, string> {
  if (!heading) return {}
  const bounds = orgPropertyDrawerBounds(buffer, heading)
  if (!bounds) return {}
  const props: Record<string, string> = {}
  const drawer = buffer.text.slice(bounds.start, bounds.end)
  for (const match of drawer.matchAll(/^:([A-Za-z0-9_]+):\s*(.*)$/gm)) {
    const key = match[1]!
    if (key === "PROPERTIES" || key === "END") continue
    props[key] = match[2] ?? ""
  }
  return props
}

function inheritedOrgProperties(buffer: BufferModel, point = buffer.point): Record<string, string> {
  const headings = orgHeadings(buffer)
  const current = orgHeadingAt(buffer, point)
  if (!current) return {}
  const lineage = headings.filter(heading =>
    heading.start <= current.start
    && heading.end >= current.end
    && heading.level <= current.level
  ).sort((a, b) => a.level - b.level)
  return Object.assign({}, ...lineage.map(heading => orgPropertiesAt(buffer, heading)))
}

function setOrgProperties(buffer: BufferModel, heading: OrgHeading, props: Record<string, string | undefined>): void {
  const existing = orgPropertiesAt(buffer, heading)
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === "") delete existing[key]
    else existing[key] = value
  }
  const lines = Object.entries(existing).map(([key, value]) => `:${key}: ${value}`)
  const drawer = lines.length ? `:PROPERTIES:\n${lines.join("\n")}\n:END:\n` : ""
  const bounds = orgPropertyDrawerBounds(buffer, heading)
  const oldPoint = buffer.point
  const start = bounds?.start ?? heading.contentStart
  const end = bounds?.end ?? heading.contentStart
  if (bounds) replaceWritable(buffer, bounds.start, bounds.end, drawer)
  else if (drawer) replaceWritable(buffer, heading.contentStart, heading.contentStart, drawer)
  const delta = drawer.length - (end - start)
  if (oldPoint >= end) buffer.point = oldPoint + delta
  else if (oldPoint >= start) buffer.point = start + drawer.length
  else buffer.point = oldPoint
}

function orgTopicDefault(heading: OrgHeading): string {
  return heading.title.toLowerCase().replace(/\s+/g, "-").slice(0, 50)
}

function orgTopicStart(buffer: BufferModel, point = buffer.point): number | null {
  const headings = orgHeadings(buffer)
  const current = orgHeadingAt(buffer, point)
  if (!current) return null
  const lineage = headings.filter(heading =>
    heading.start <= current.start
    && heading.end >= current.end
    && heading.level <= current.level
  ).sort((a, b) => b.level - a.level)
  return lineage.find(heading => orgPropertiesAt(buffer, heading).GPTEL_TOPIC != null)?.start ?? null
}

function orgPromptSlice(buffer: BufferModel, start: number, end: number): string {
  return stripOrgPromptMetadata(buffer.text.slice(start, end))
}

function stripOrgPromptMetadata(text: string): string {
  return text
    .replace(/^:PROPERTIES:\n[\s\S]*?^:END:\n?/gm, "")
    .trim()
}

function orgBranchPrompt(buffer: BufferModel, promptEnd: number): string | null {
  const headings = orgHeadings(buffer)
  const current = orgHeadingAt(buffer, promptEnd)
  if (!current) return null
  const lineage = new Set(headings
    .filter(heading => heading.start <= current.start && heading.end >= current.end && heading.level <= current.level)
    .map(heading => heading.start))
  const firstHeading = headings[0]?.start ?? promptEnd
  const pieces: string[] = []
  if (firstHeading > 0) pieces.push(buffer.text.slice(0, Math.min(firstHeading, promptEnd)))
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]!
    if (heading.start >= promptEnd) break
    const next = headings[i + 1]?.start ?? promptEnd
    if (lineage.has(heading.start)) pieces.push(buffer.text.slice(heading.start, Math.min(next, promptEnd)))
  }
  return stripOrgPromptMetadata(pieces.join(""))
}

function orgScopedPromptForDeps(deps: GptelDeps, buffer: BufferModel, prompt: string, promptEnd: number): string {
  if (buffer.mode !== "org-mode") return prompt
  const topicStart = orgTopicStart(buffer, promptEnd)
  if (topicStart != null) return orgPromptSlice(buffer, topicStart, promptEnd)
  if (deps.getCustom<boolean>("gptel-org-branching-context")) return orgBranchPrompt(buffer, promptEnd) ?? prompt
  return stripOrgPromptMetadata(prompt)
}

async function saveOrgGptelProperties(editor: Editor, deps: GptelDeps, buffer: BufferModel): Promise<boolean> {
  if (buffer.mode !== "org-mode") return false
  await editor.runHook("gptel-save-state-hook", buffer)
  const heading = orgHeadingAt(buffer, buffer.point) ?? orgHeadings(buffer)[0]
  if (!heading) return false
  const existing = orgPropertiesAt(buffer, heading)
  const existingTopic = existing.GPTEL_TOPIC ?? buffer.text.slice(heading.start, heading.end).match(/^:GPTEL_TOPIC:\s*(.*)$/m)?.[1]
  const histories = reconcileResponseHistories(editor, deps, buffer)
  setOrgProperties(buffer, heading, {
    GPTEL_TOPIC: existingTopic,
    GPTEL_SYSTEM: systemMessage(deps).replace(/\n/g, "\\n"),
    GPTEL_BACKEND: deps.getCustom<string>("gptel-backend"),
    GPTEL_MODEL: deps.getCustom<string>("gptel-model"),
    GPTEL_TEMPERATURE: String(deps.getCustom<number>("gptel-temperature") ?? ""),
    GPTEL_MAX_TOKENS: String(deps.getCustom<number>("gptel-max-tokens") ?? ""),
    GPTEL_TOOLS: deps.getCustom<string>("gptel-tools"),
    GPTEL_RESPONSE_HISTORY: histories.length
      ? JSON.stringify(histories.map(history => ({
        start: history.start,
        end: history.end,
        variants: history.variants,
        variantIndex: history.variantIndex,
      })))
      : undefined,
    GPTEL_PRESET: undefined,
  })
  buffer.locals.set(STATE_RESTORED, true)
  return true
}

function restoreOrgGptelProperties(editor: Editor, deps: GptelDeps, buffer: BufferModel): boolean {
  if (buffer.mode !== "org-mode") return false
  const props = inheritedOrgProperties(buffer)
  if (!Object.keys(props).some(key => key.startsWith("GPTEL_"))) return false
  if (props.GPTEL_BACKEND) deps.setCustom("gptel-backend", props.GPTEL_BACKEND)
  if (props.GPTEL_MODEL) deps.setCustom("gptel-model", props.GPTEL_MODEL)
  if (props.GPTEL_SYSTEM) setSystemMessage(deps, props.GPTEL_SYSTEM.replace(/\\n/g, "\n"))
  if (props.GPTEL_TOOLS != null) deps.setCustom("gptel-tools", props.GPTEL_TOOLS)
  if (props.GPTEL_TEMPERATURE && Number.isFinite(Number(props.GPTEL_TEMPERATURE))) deps.setCustom("gptel-temperature", Number(props.GPTEL_TEMPERATURE))
  if (props.GPTEL_MAX_TOKENS && Number.isFinite(Number(props.GPTEL_MAX_TOKENS))) deps.setCustom("gptel-max-tokens", Number(props.GPTEL_MAX_TOKENS))
  if (props.GPTEL_RESPONSE_HISTORY) {
    try {
      const histories = JSON.parse(props.GPTEL_RESPONSE_HISTORY) as Array<{ start: number; end: number; variants: string[]; variantIndex: number }>
      if (Array.isArray(histories)) {
        const st = state(editor)
        st.responseHistories = [
          ...st.responseHistories.filter(history => history.bufferId !== buffer.id),
          ...histories
            .filter(history => Number.isFinite(history.start) && Number.isFinite(history.end) && Array.isArray(history.variants))
            .map(history => normalizeResponseHistory(buffer, {
              bufferId: buffer.id,
              start: history.start,
              end: history.end,
              variants: history.variants,
              variantIndex: history.variantIndex,
            })),
        ]
      }
    } catch {
      // Ignore stale or hand-edited Org property values.
    }
  }
  buffer.locals.set(STATE_RESTORED, true)
  return true
}

function chatHistory(buffer: BufferModel, markers: GptelChatMarkers = defaultChatMarkers()): GptelMessage[] {
  const messages: GptelMessage[] = []
  const alternatives = markerAlternatives(markers)
  const regex = new RegExp(`(${alternatives.map(escapeRegExp).join("|")})([\\s\\S]*?)(?=${alternatives.map(escapeRegExp).join("|")}|$)`, "g")
  for (const match of buffer.text.matchAll(regex)) {
    const marker = match[1] ?? ""
    const role = marker === markerText(markers, "user", true) || marker === markerText(markers, "user") ? "user" : "assistant"
    const content = stripStateBlocks(match[2] ?? "")
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
  const system = systemMessage(deps)
  if (system) messages.push({ role: "system", content: system })
  const contextMode = deps.getCustom<boolean | string>("gptel-use-context") ?? "system"
  const useContext = contextMode !== false && contextMode !== "false" && contextMode !== "nil" && contextMode !== "no"
  const contextItems = useContext ? contextItemsForRequest(editor, buffer) : []
  const contextStringFunction = deps.getCustom<GptelContextStringFunction>("gptel-context-string-function") ?? gptelContextString
  const wrapFunction = deps.getCustom<GptelContextWrapFunction>("gptel-context-wrap-function") ?? gptelContextWrapDefault
  const context = useContext ? contextStringFunction(contextItems, editor, buffer) : ""
  const media = useContext ? mediaPartsFromContext(contextItems) : []
  if (context && contextMode === "system") {
    const systemIndex = messages.findIndex(message => message.role === "system")
    if (systemIndex >= 0) messages[systemIndex] = { ...messages[systemIndex]!, content: `${messages[systemIndex]!.content}\n\n${context}` }
    else messages.push({ role: "system", content: context })
  }
  const history = (buffer.mode === GPTEL_CHAT_MODE || buffer.minorModes.has(GPTEL_MODE)) ? chatHistory(buffer, markers) : []
  const limit = deps.getCustom<number | null>("gptel-num-messages-to-send")
  const priorHistory = typeof limit === "number" && limit >= 0 ? history.slice(0, -1).slice(-limit) : history.slice(0, -1)
  const includeReasoning = deps.getCustom<boolean | string>("gptel-include-reasoning")
  messages.push(...priorHistory.map(message =>
    message.role === "assistant" && includeReasoning === "ignore"
      ? { ...message, content: stripReasoningBlocks(message.content) }
      : message
  ))
  const promptWithContext = context && contextMode !== "system" ? wrapFunction(context, prompt, contextMode) : prompt
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

function insertWritable(buffer: BufferModel, position: number, text: string): void {
  const oldPoint = buffer.point
  const wasReadOnly = buffer.readOnly
  buffer.readOnly = false
  buffer.point = Math.max(0, Math.min(position, buffer.text.length))
  buffer.insert(text)
  buffer.point = oldPoint <= position ? oldPoint : oldPoint + text.length
  buffer.readOnly = wasReadOnly
}

function replaceWritable(buffer: BufferModel, start: number, end: number, text: string): void {
  const wasReadOnly = buffer.readOnly
  buffer.readOnly = false
  buffer.replaceRange(start, end, text)
  buffer.readOnly = wasReadOnly
}

function appendReasoningToTarget(editor: Editor, targetName: string, reasoning: string): void {
  const target = [...editor.buffers.values()].find(buffer => buffer.name === targetName) ?? editor.scratch(targetName, "", "markdown")
  appendWritable(target, `${reasoning}${reasoning.endsWith("\n") ? "" : "\n"}`)
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
  const confirmSetting = deps.getCustom<boolean | string>("gptel-confirm-tool-calls")
  const confirmed = confirmSetting === true || confirmSetting === "true" || confirmSetting === "t" || (confirmSetting === "auto" && tool?.confirm === true)
  return tool?.include === true || (confirmed && tool?.confirm !== false)
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

function cacheEnabled(deps: GptelDeps, part: "system" | "tool" | "message"): boolean {
  const value = deps.getCustom<boolean | string>("gptel-cache")
  if (value === true || value === "true" || value === "t" || value === "yes") return true
  if (value === false || value === "false" || value === "nil" || value === "no" || value == null || value === "") return false
  return String(value).split(/[, ()]+/).map(item => item.trim()).filter(Boolean).includes(part)
}

function reasoningBlock(reasoning: string, include: boolean | "ignore" | string): string {
  if (!reasoning || include === false) return ""
  if (typeof include === "string" && include !== "ignore") return ""
  return `\`\`\` reasoning\n${reasoning.trim()}\n\`\`\`\n\n`
}

function reasoningBufferName(include: boolean | "ignore" | string): string | undefined {
  return typeof include === "string" && include !== "ignore" ? include : undefined
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

function anthropicCacheControl(): Record<string, unknown> {
  return { type: "ephemeral" }
}

function anthropicSystem(system: string | undefined, cached: boolean): unknown {
  if (!system) return undefined
  return cached ? [{ type: "text", text: system, cache_control: anthropicCacheControl() }] : system
}

function anthropicToolsWithCache(tools: unknown[], cached: boolean): unknown[] {
  if (!cached || !tools.length) return tools
  return tools.map((tool, index) => index === tools.length - 1 && tool && typeof tool === "object" && !Array.isArray(tool)
    ? { ...(tool as Record<string, unknown>), cache_control: anthropicCacheControl() }
    : tool)
}

function anthropicMessagesWithCache(messages: unknown[], cached: boolean): unknown[] {
  if (!cached || !messages.length) return messages
  const lastIndex = messages.length - 1
  return messages.map((message, index) => {
    if (index !== lastIndex || !message || typeof message !== "object" || Array.isArray(message)) return message
    const record = { ...(message as Record<string, unknown>) }
    if (typeof record.content === "string") {
      record.content = [{ type: "text", text: record.content, cache_control: anthropicCacheControl() }]
    } else if (Array.isArray(record.content) && record.content.length) {
      const content = [...record.content]
      const last = content[content.length - 1]
      if (last && typeof last === "object" && !Array.isArray(last)) {
        content[content.length - 1] = { ...(last as Record<string, unknown>), cache_control: anthropicCacheControl() }
        record.content = content
      }
    }
    return record
  })
}

function bedrockToolsWithCache(tools: unknown[], cached: boolean): unknown[] {
  return cached && tools.length ? [...tools, { cachePoint: { type: "default" } }] : tools
}

function requestBody(
  backend: GptelBackend,
  model: string,
  messages: GptelMessage[],
  deps: GptelDeps,
  stream: boolean,
  tools: GptelTool[] = [],
): unknown {
  const temperature = deps.getCustom<number | null>("gptel-temperature")
  const maxTokens = deps.getCustom<number | null>("gptel-max-tokens")
  const extra = requestParams(backend)
  const schema = currentSchema(deps)
  if (backend.kind === "anthropic") {
    const system = messages.find(m => m.role === "system")?.content
    const backendTools = anthropicToolsWithCache(
      [...(schema ? [anthropicSchemaTool(schema)] : []), ...tools.map(anthropicTool)],
      cacheEnabled(deps, "tool"),
    )
    return {
      model,
      max_tokens: maxTokens ?? 4096,
      temperature: temperature ?? undefined,
      stream,
      system: anthropicSystem(system, cacheEnabled(deps, "system")),
      messages: anthropicMessagesWithCache(anthropicMessages(messages), cacheEnabled(deps, "message")),
      tools: backendTools.length ? backendTools : undefined,
      tool_choice: schema ? { type: "tool", name: "response_json" } : undefined,
      ...extra,
    }
  }
  if (backend.kind === "gemini") {
    return {
      contents: providerMessagesForBackend(backend, messages),
      systemInstruction: messages.find(m => m.role === "system") ? { parts: [{ text: messages.find(m => m.role === "system")!.content }] } : undefined,
      generationConfig: {
        temperature: temperature ?? undefined,
        maxOutputTokens: maxTokens ?? undefined,
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
    const backendTools = bedrockToolsWithCache(tools.map(bedrockTool), cacheEnabled(deps, "tool"))
    return {
      messages: providerMessagesForBackend(backend, messages),
      system: system ? [{ text: system }, ...(cacheEnabled(deps, "system") ? [{ cachePoint: { type: "default" } }] : [])] : undefined,
      inferenceConfig: {
        maxTokens: maxTokens ?? undefined,
        temperature: temperature ?? undefined,
      },
      toolConfig: backendTools.length ? { toolChoice: { auto: {} }, tools: backendTools } : undefined,
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
      temperature: temperature ?? undefined,
      max_output_tokens: maxTokens ?? undefined,
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
    temperature: temperature ?? undefined,
    max_tokens: maxTokens ?? undefined,
    ...extra,
  }
}

function requestHeaders(backend: GptelBackend, deps: Pick<GptelDeps, "getCustom">): Record<string, string> {
  const key = backendKey(backend, deps)
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

function requestPayload(backend: GptelBackend, model: string, messages: GptelMessage[], deps: GptelDeps, tools: GptelTool[] = []): GptelRequestPayload {
  const stream = backend.stream !== false && deps.getCustom<boolean>("gptel-stream") !== false && !tools.length
  return {
    url: backendUrl(backend, model),
    headers: requestHeaders(backend, deps),
    body: requestBody(backend, model, messages, deps, stream, tools),
    stream,
  }
}

function gptelFsmStart(editor: Editor, deps: GptelDeps, buffer: BufferModel, backend: GptelBackend, model: string, payload?: GptelRequestPayload): GptelRequestFsm {
  const fsm: GptelRequestFsm = {
    id: `gptel-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    bufferId: buffer.id,
    backend: backend.name,
    model,
    state: "INIT",
    active: true,
    editor,
    deps,
    payload,
    history: [{ state: "INIT", at: new Date().toISOString() }],
  }
  const fsms = state(editor).requestFsms
  fsms.push(fsm)
  if (fsms.length > 50) fsms.splice(0, fsms.length - 50)
  gptelUpdateStatus(editor, deps, buffer, "Ready")
  return fsm
}

function gptelFsmTransition(fsm: GptelRequestFsm | undefined, next: GptelRequestFsmState, note?: string): void {
  if (!fsm) return
  if (fsm.state === next && next !== "TOOL") return
  fsm.state = next
  fsm.active = next !== "DONE" && next !== "ERRS"
  fsm.history.push({ state: next, at: new Date().toISOString(), note })
  const buffer = fsm.editor.buffers.get(fsm.bufferId)
  if (!buffer) return
  const status = next === "WAIT"
    ? "Waiting..."
    : next === "TYPE"
      ? "Typing..."
      : next === "TOOL"
        ? "Waiting..."
        : next === "DONE"
          ? fsm.toolResults ? "Ready with tool results" : "Ready"
          : `Error: ${note ?? "request failed"}`
  gptelUpdateStatus(fsm.editor, fsm.deps, buffer, status, { message: next !== "TYPE" })
}

function gptelFsmInspectText(editor: Editor): string {
  const fsms = [...state(editor).requestFsms].reverse()
  if (!fsms.length) return "No gptel request log yet.\n"
  const lines = [
    "Buffer\tBackend/Model\tState\tHistory",
    ...fsms.map(fsm => {
      const buffer = editor.buffers.get(fsm.bufferId)
      const history = fsm.history
        .map(item => `${item.state}@${item.at}${item.note ? `(${item.note})` : ""}`)
        .join(" -> ")
      return [
        buffer ? editor.bufferDisplayName(buffer) : `<dead ${fsm.bufferId}>`,
        `${fsm.backend}/${fsm.model}`,
        fsm.state,
        history,
      ].join("\t")
    }),
  ]
  return `${lines.join("\n")}\n`
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function gptelCurlCommand(payload: GptelRequestPayload): string {
  const args = [
    "curl",
    "-X", "POST",
    payload.url,
    ...Object.entries(payload.headers).flatMap(([key, value]) => ["-H", `${key}: ${value}`]),
    "--data-raw", JSON.stringify(payload.body),
  ]
  return args.map(shellSingleQuote).join(" ")
}

function parseInspectQueryPayload(buffer: BufferModel): GptelRequestPayload | null {
  const meta = buffer.locals.get(INSPECT_QUERY_META) as GptelInspectQueryMeta | undefined
  if (!meta) return null
  const parsed = JSON.parse(buffer.text)
  if (meta.format === "json") return { ...meta.payload, body: parsed }
  const payload = parsed as Partial<GptelRequestPayload>
  return {
    url: typeof payload.url === "string" ? payload.url : meta.payload.url,
    headers: isPlainObject(payload.headers) ? Object.fromEntries(Object.entries(payload.headers).map(([k, v]) => [k, String(v)])) : meta.payload.headers,
    body: hasOwn(payload as Record<string, unknown>, "body") ? payload.body : parsed,
    stream: typeof payload.stream === "boolean" ? payload.stream : meta.payload.stream,
  }
}

function providerMessagesFromBody(backend: GptelBackend, body: unknown): GptelMessage[] {
  if (!isPlainObject(body)) return []
  if (backend.kind === "anthropic") {
    const messages: GptelMessage[] = []
    const system = typeof body.system === "string" ? body.system : Array.isArray(body.system)
      ? body.system.map((part: any) => part?.text ?? "").join("")
      : ""
    if (system) messages.push({ role: "system", content: system })
    if (Array.isArray(body.messages)) {
      messages.push(...body.messages.map((message: any) => ({
        role: message.role === "assistant" ? "assistant" : message.role === "tool" ? "tool" : "user",
        content: Array.isArray(message.content)
          ? message.content.map((part: any) => part?.text ?? "").join("")
          : String(message.content ?? ""),
      } satisfies GptelMessage)))
    }
    return messages
  }
  if (backend.kind === "openai-responses" && Array.isArray(body.input)) {
    return body.input.map((message: any) => ({
      role: message.role === "developer" ? "system" : message.role === "assistant" ? "assistant" : message.role === "tool" ? "tool" : "user",
      content: Array.isArray(message.content)
        ? message.content.map((part: any) => part?.text ?? part?.content ?? "").join("")
        : String(message.content ?? ""),
    } satisfies GptelMessage))
  }
  if (Array.isArray(body.messages)) {
    return body.messages.map((message: any) => ({
      role: message.role === "system" || message.role === "assistant" || message.role === "tool" ? message.role : "user",
      content: Array.isArray(message.content)
        ? message.content.map((part: any) => typeof part === "string" ? part : part?.text ?? "").join("")
        : String(message.content ?? ""),
      name: typeof message.name === "string" ? message.name : undefined,
      toolCallId: typeof message.tool_call_id === "string" ? message.tool_call_id : undefined,
    } satisfies GptelMessage))
  }
  return []
}

function payloadToolNames(body: unknown): string[] {
  if (!isPlainObject(body)) return []
  const names: string[] = []
  const tools = Array.isArray(body.tools) ? body.tools : Array.isArray((body.toolConfig as any)?.tools) ? (body.toolConfig as any).tools : []
  for (const tool of tools) {
    const record = tool as any
    const name = record?.function?.name ?? record?.name ?? record?.toolSpec?.name
    if (typeof name === "string") names.push(name)
  }
  return [...new Set(names)]
}

function toolsForPayload(editor: Editor, deps: GptelDeps, payload: GptelRequestPayload): GptelTool[] {
  const names = payloadToolNames(payload.body)
  if (!names.length) return selectedTools(editor, deps)
  const st = state(editor)
  return names.map(name => st.tools.get(name)).filter((tool): tool is GptelTool => Boolean(tool))
}

function logLevel(deps: GptelDeps): string | false {
  const value = deps.getCustom<boolean | string>("gptel-log-level")
  if (!value || value === "off" || value === "nil" || value === "false") return false
  return value === true ? "info" : String(value)
}

function logBuffer(editor: Editor, text: string): BufferModel {
  const buffer = [...editor.buffers.values()].find(candidate => candidate.name === "*gptel-log*")
    ?? editor.scratch("*gptel-log*", "", "text")
  if (text) appendWritable(buffer, text)
  return buffer
}

function logJson(editor: Editor, deps: GptelDeps, type: string, data: unknown, noJson = false): void {
  if (!logLevel(deps)) return
  const body = noJson
    ? String(data)
    : typeof data === "string" ? data : JSON.stringify(data, null, 2)
  const existing = [...editor.buffers.values()].find(buffer => buffer.name === "*gptel-log*")
  logBuffer(editor, `${existing?.text ? "\n" : ""}{"gptel":"${type}","timestamp":"${new Date().toISOString()}"}\n${body}\n`)
}

function inspectPayloadBuffer(editor: Editor, payload: GptelRequestPayload, format: "json" | "object" = "object", meta?: Omit<GptelInspectQueryMeta, "payload" | "format">): BufferModel {
  const body = format === "json"
    ? JSON.stringify(payload.body, null, 2)
    : JSON.stringify(payload, null, 2)
  const buffer = editor.scratch("*gptel-query*", body, format === "json" ? "json" : GPTEL_QUERY_MODE)
  editor.enterMode(buffer, format === "json" ? "json" : GPTEL_QUERY_MODE)
  editor.enableMinorMode(GPTEL_QUERY_MINOR_MODE, { buffer })
  buffer.readOnly = false
  if (meta) buffer.locals.set(INSPECT_QUERY_META, { ...meta, payload, format } satisfies GptelInspectQueryMeta)
  buffer.point = 0
  editor.switchToBuffer(buffer.id)
  return buffer
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

function formatHeaderUsage(usage: GptelTokenUsage | undefined): string {
  if (!usage) return ""
  const parts: string[] = []
  if (usage.input != null) parts.push(`${usage.input}${usage.cached ? `, C${usage.cached}` : ""} up`)
  if (usage.output != null) parts.push(`${usage.output} down`)
  return parts.length ? ` [${parts.join(" ")}]` : ""
}

function gptelStatusText(editor: Editor, deps: GptelDeps, buffer: BufferModel): string {
  const backend = backendByName(editor, deps)
  const model = currentModel(editor, deps, backend)
  const status = buffer.locals.get(STATUS_LOCAL) as string | undefined
  const usage = state(editor).lastRequest?.bufferId === buffer.id ? formatHeaderUsage(state(editor).lastRequest?.usage) : ""
  return `${status ?? "Ready"} ${backend.name}/${model}${usage}`
}

export function gptelUpdateStatus(editor: Editor, deps: GptelDeps, buffer: BufferModel, msg: string, options: { message?: boolean } = {}): void {
  if (!buffer.minorModes.has(GPTEL_MODE)) return
  buffer.locals.set(STATUS_LOCAL, msg.trim())
  // Jemacs does not expose an Emacs-style buffer header-line-format yet.  The
  // installer registers a mode-line-misc-info segment as the closest always
  // visible buffer-local surface, and transition messages keep echo-area parity.
  if (options.message) editor.message(`gptel: ${gptelStatusText(editor, deps, buffer)}`)
  void editor.changed("gptel-status")
}

function gptelHighlightMethods(deps: GptelDeps): Set<string> {
  const raw = deps.getCustom<string | string[]>("gptel-highlight-methods")
  if (Array.isArray(raw)) return new Set(raw)
  return new Set(String(raw ?? "face").split(/[, ]+/).filter(Boolean))
}

export function gptelHighlightSpans(deps: GptelDeps, buffer: BufferModel): TextSpan[] {
  if (!buffer.minorModes.has("gptel-highlight-mode")) return []
  const methods = gptelHighlightMethods(deps)
  if (!methods.has("face")) {
    if (!buffer.locals.get(HIGHLIGHT_COMMENT_LOCAL)) {
      buffer.locals.set(HIGHLIGHT_COMMENT_LOCAL, true)
      // Jemacs has no fringe or margin overlay API at present; response
      // highlighting therefore uses font-lock faces only.
    }
    return []
  }
  return responseRanges(buffer, chatMarkers(deps, buffer)).map(range => ({
    start: range.start,
    end: range.end,
    face: "gptel-response-highlight" as any,
  }))
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

function reasoningFromStreamEvent(backend: GptelBackend, data: string): string {
  if (!data || data === "[DONE]") return ""
  let json: any
  try { json = JSON.parse(data) } catch { return "" }
  if (backend.kind === "anthropic") return json.delta?.thinking ?? ""
  if (backend.kind === "gemini") {
    const parts = json.candidates?.flatMap((c: any) => c.content?.parts ?? []) ?? []
    return parts.filter((part: any) => part.thought).map((part: any) => part.text ?? "").join("")
  }
  if (backend.kind === "ollama") return json.message?.thinking ?? json.thinking ?? ""
  if (backend.kind === "openai-responses") return json.type === "response.reasoning_summary_text.delta" || json.type === "response.reasoning.delta" ? json.delta ?? "" : ""
  const choice = json.choices?.[0]
  return choice?.delta?.reasoning ?? choice?.delta?.reasoning_content ?? ""
}

async function requestLlm(
  editor: Editor,
  deps: GptelDeps,
  backend: GptelBackend,
  model: string,
  messages: GptelMessage[],
  options: { onDelta?: (delta: string) => void; onReasoning?: (reasoning: string) => void; signal?: AbortSignal; tools?: GptelTool[]; payload?: GptelRequestPayload; fsm?: GptelRequestFsm } = {},
): Promise<RequestResult> {
  if (backend.kind === "mock") {
    const response = `Mock response to: ${messages.at(-1)?.content ?? ""}`
    gptelFsmTransition(options.fsm, "WAIT")
    for (const token of response.match(/.{1,16}/g) ?? []) {
      gptelFsmTransition(options.fsm, "TYPE")
      options.onDelta?.(token)
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    return { text: response }
  }

  const payload = options.payload ?? requestPayload(backend, model, messages, deps, options.tools)
  if (options.fsm) options.fsm.payload = payload
  const level = logLevel(deps)
  if (level === "debug") logJson(editor, deps, "request headers", payload.headers)
  logJson(editor, deps, "request body", payload.body)
  gptelFsmTransition(options.fsm, "WAIT")
  const response = await fetch(payload.url, {
    method: "POST",
    headers: payload.headers,
    body: JSON.stringify(payload.body),
    signal: options.signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`${backend.name} ${response.status}: ${body || response.statusText}`)
  }
  const includeReasoning = includeReasoningSetting(deps)
  if (!payload.stream || !response.body) {
    const json = await response.json()
    gptelFsmTransition(options.fsm, "TYPE")
    if (level === "debug") logJson(editor, deps, "response body", json)
    if (reasoningBufferName(includeReasoning)) {
      const reasoning = reasoningFromJson(backend, json)
      if (reasoning) options.onReasoning?.(reasoning)
    }
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
      logJson(editor, deps, "response body", event, true)
      const parsed = parseJsonMaybe(event)
      if (typeof parsed === "object" && parsed) usage = usageFromJson(backend, parsed) ?? usage
      if (reasoningBufferName(includeReasoning)) {
        const reasoning = reasoningFromStreamEvent(backend, event)
        if (reasoning) options.onReasoning?.(reasoning)
      }
      const delta = textFromStreamEvent(backend, event, includeReasoning)
      if (!delta) continue
      text += delta
      gptelFsmTransition(options.fsm, "TYPE")
      options.onDelta?.(delta)
      void editor.changed("gptel-stream")
    }
  }
  for (const event of parseSseEvents(pending)) {
    logJson(editor, deps, "response body", event, true)
    const parsed = parseJsonMaybe(event)
    if (typeof parsed === "object" && parsed) usage = usageFromJson(backend, parsed) ?? usage
    if (reasoningBufferName(includeReasoning)) {
      const reasoning = reasoningFromStreamEvent(backend, event)
      if (reasoning) options.onReasoning?.(reasoning)
    }
    const delta = textFromStreamEvent(backend, event, includeReasoning)
    text += delta
    if (delta) gptelFsmTransition(options.fsm, "TYPE")
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function makeToolResult(call: GptelToolCall, content: unknown): GptelMessage {
  return {
    role: "tool",
    name: call.name,
    toolCallId: call.id,
    content: toolResultString(content),
  }
}

function blockedToolResult(call: GptelToolCall, reason?: string): GptelMessage {
  return makeToolResult(call, `<tool_call_error>\n${reason ?? `Tool ${call.name} blocked by user`}\n</tool_call_error>`)
}

type PreToolDecision = {
  call: GptelToolCall
  blocked?: GptelMessage
  shortCircuit?: GptelMessage
  stop?: boolean
}

type PostToolDecision = {
  result: GptelMessage
  stop?: boolean
}

type ToolExecutionResult = {
  calls: GptelToolCall[]
  results: GptelMessage[]
  stop?: boolean
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

async function confirmToolCalls(
  editor: Editor,
  deps: GptelDeps,
  toolCalls: readonly GptelToolCall[],
  tools: ReadonlyMap<string, GptelTool>,
): Promise<"accept" | "reject"> {
  const setting = deps.getCustom<boolean | string>("gptel-confirm-tool-calls")
  if (setting === false || setting === "false" || setting === "nil" || setting === "no") return "accept"
  const callsNeedingConfirmation = setting === "auto"
    ? toolCalls.filter(call => call.confirm === true || (call.confirm == null && tools.get(call.name)?.confirm === true))
    : toolCalls.filter(call => call.confirm === true || (call.confirm == null && tools.get(call.name)?.confirm !== false))
  if (!callsNeedingConfirmation.length) return "accept"
  const names = callsNeedingConfirmation.map(call => call.name).join(", ")
  const st = state(editor)
  const commandDecision = new Promise<"accept" | "reject">(resolve => {
    st.pendingToolCalls = { bufferId: editor.currentBuffer.id, calls: [...toolCalls], resolve }
  })
  const promptDecision = (async (): Promise<"accept" | "reject"> => {
    for (;;) {
      const answer = (await editor.prompt(`Run gptel tool call${callsNeedingConfirmation.length > 1 ? "s" : ""} (${names})? y, n, or i: `, "n", "gptel-tool-confirm"))?.trim().toLowerCase()
      if (answer === "y" || answer === "yes") return "accept"
      if (answer === "i" || answer === "inspect") {
        const buffer = editor.scratch("*gptel tool calls*", `${gptelToolCallSummary(toolCalls)}\n`, "gptel-inspect")
        buffer.readOnly = true
        editor.switchToBuffer(buffer.id)
        continue
      }
      return "reject"
    }
  })()
  const decision = await Promise.race([commandDecision, promptDecision])
  if (st.pendingToolCalls?.calls.every((call, index) => call === toolCalls[index])) st.pendingToolCalls = undefined
  return decision
}

function decidePendingToolCalls(editor: Editor, decision: "accept" | "reject"): boolean {
  const pending = state(editor).pendingToolCalls
  if (!pending) {
    editor.message("gptel: no pending tool calls")
    return false
  }
  state(editor).pendingToolCalls = undefined
  pending.resolve(decision)
  editor.message(decision === "accept" ? "gptel: accepted tool calls" : "gptel: rejected tool calls")
  return true
}

async function runPreToolCallFunctions(editor: Editor, deps: GptelDeps, buffer: BufferModel, backend: GptelBackend, model: string, call: GptelToolCall, tool: GptelTool | undefined): Promise<PreToolDecision> {
  const ctx = { editor, buffer, backend, model }
  let current = call
  for (const fn of state(editor).preToolCallFunctions) {
    const next = await fn(current, tool, ctx)
    if (next == null || next === true) continue
    if (next === false) return { call: current, stop: true }
    if (!isRecord(next)) continue
    if (hasOwn(next, "id") || (hasOwn(next, "arguments") && !hasOwn(next, "args") && !hasOwn(next, "block") && !hasOwn(next, "stop") && !hasOwn(next, "result") && !hasOwn(next, "confirm"))) {
      current = { ...current, ...(next as Partial<GptelToolCall>) }
      continue
    }
    const directive = next as Record<string, unknown>
    if (hasOwn(directive, "name") && typeof directive.name === "string") current = { ...current, name: directive.name }
    if (hasOwn(directive, "args") || hasOwn(directive, "arguments")) current = { ...current, arguments: hasOwn(directive, "args") ? directive.args : directive.arguments }
    if (hasOwn(directive, "confirm") && typeof directive.confirm === "boolean") current = { ...current, confirm: directive.confirm } as GptelToolCall
    if (directive.block) return { call: current, blocked: blockedToolResult(current, typeof directive.block === "string" ? directive.block : undefined) }
    if (hasOwn(directive, "result")) return { call: current, shortCircuit: makeToolResult(current, directive.result) }
    if (directive.stop) return { call: current, stop: true }
  }
  await editor.runHook("gptel-pre-tool-call-functions", buffer)
  return { call: current }
}

async function runPostToolCallFunctions(editor: Editor, deps: GptelDeps, buffer: BufferModel, backend: GptelBackend, model: string, call: GptelToolCall, result: GptelMessage, tool: GptelTool | undefined): Promise<PostToolDecision> {
  const ctx = { editor, buffer, backend, model }
  let current = result
  let stop = false
  for (const fn of state(editor).postToolCallFunctions) {
    const next = await fn(call, current, tool, ctx)
    if (!next) continue
    if (!isRecord(next)) continue
    const directive = next as Record<string, unknown>
    if (hasOwn(directive, "role") && directive.role === "tool") {
      current = next as GptelMessage
      continue
    }
    if (directive.block) current = blockedToolResult(call, typeof directive.block === "string" ? directive.block : undefined)
    if (hasOwn(directive, "result")) current = { ...current, content: toolResultString(directive.result) }
    if (directive.stop) stop = true
  }
  await editor.runHook("gptel-post-tool-call-functions", buffer)
  return { result: current, stop }
}

async function callGptelTool(tool: GptelTool, args: unknown, ctx: { editor: Editor; buffer: BufferModel }): Promise<unknown> {
  if (!tool.async) return await (tool.function as (args: unknown, ctx: { editor: Editor; buffer: BufferModel }) => unknown | Promise<unknown>)(args, ctx)
  return await new Promise<unknown>((resolve, reject) => {
    let settled = false
    const callback = (result: unknown) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      ;(tool.function as (callback: (result: unknown) => void, args: unknown, ctx: { editor: Editor; buffer: BufferModel }) => void)(callback, args, ctx)
    } catch (error) {
      if (!settled) {
        settled = true
        reject(error)
      }
    }
  })
}

async function executeToolCalls(
  editor: Editor,
  deps: GptelDeps,
  buffer: BufferModel,
  toolCalls: readonly GptelToolCall[],
  backend: GptelBackend,
  model: string,
): Promise<ToolExecutionResult | null> {
  const st = state(editor)
  const results: GptelMessage[] = []
  const resultCalls: GptelToolCall[] = []
  const executable: Array<{ call: GptelToolCall; tool: GptelTool }> = []
  for (const requestedCall of toolCalls) {
    const initialTool = st.tools.get(requestedCall.name)
    const decision = await runPreToolCallFunctions(editor, deps, buffer, backend, model, requestedCall, initialTool)
    const call = decision.call
    let tool = st.tools.get(call.name)
    if (decision.blocked || decision.shortCircuit) {
      const post = await runPostToolCallFunctions(editor, deps, buffer, backend, model, call, decision.blocked ?? decision.shortCircuit!, tool)
      results.push(post.result)
      resultCalls.push(call)
      if (decision.stop || post.stop) return { calls: resultCalls, results, stop: true }
      continue
    }
    if (decision.stop) return { calls: resultCalls, results, stop: true }
    if (!tool) {
      const post = await runPostToolCallFunctions(editor, deps, buffer, backend, model, call, {
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: `No such gptel tool: ${call.name}`,
      }, tool)
      results.push(post.result)
      resultCalls.push(call)
      if (post.stop) return { calls: resultCalls, results, stop: true }
      continue
    }
    executable.push({ call, tool })
  }
  const confirmed = await confirmToolCalls(editor, deps, executable.map(item => item.call), st.tools)
  if (confirmed === "reject") {
    for (const { call, tool } of executable) {
      const post = await runPostToolCallFunctions(editor, deps, buffer, backend, model, call, makeToolResult(call, "Tool call declined by user"), tool)
      results.push(post.result)
      resultCalls.push(call)
      if (post.stop) return { calls: resultCalls, results, stop: true }
    }
    return { calls: resultCalls, results }
  }
  for (const { call, tool } of executable) {
    try {
      editor.message(`gptel tool: ${call.name}`)
      const value = await callGptelTool(tool, call.arguments, { editor, buffer })
      const post = await runPostToolCallFunctions(editor, deps, buffer, backend, model, call, {
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: toolResultString(value),
      }, tool)
      results.push(post.result)
      resultCalls.push(call)
      if (post.stop) return { calls: resultCalls, results, stop: true }
    } catch (error) {
      const post = await runPostToolCallFunctions(editor, deps, buffer, backend, model, call, {
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
      }, tool)
      results.push(post.result)
      resultCalls.push(call)
      if (post.stop) return { calls: resultCalls, results, stop: true }
    }
  }
  return { calls: resultCalls, results }
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
  options: { onDelta?: (delta: string) => void; onReasoning?: (reasoning: string) => void; onToolResults?: (calls: GptelToolCall[], results: GptelMessage[], tools: ReadonlyMap<string, GptelTool>) => void; signal?: AbortSignal; tools?: GptelTool[]; firstPayload?: GptelRequestPayload; fsm?: GptelRequestFsm } = {},
): Promise<RequestResult> {
  const tools = options.tools ?? selectedTools(editor, deps)
  const maxRounds = Math.max(0, deps.getCustom<number>("gptel-max-tool-rounds") ?? 3)
  let conversation = [...messages]
  let finalText = ""
  for (let round = 0; round <= maxRounds; round++) {
    const result = await requestLlm(editor, deps, backend, model, conversation, {
      ...options,
      tools,
      payload: round === 0 ? options.firstPayload : undefined,
      fsm: options.fsm,
      onDelta: round === 0 ? options.onDelta : undefined,
      onReasoning: options.onReasoning,
    })
    if (result.text) finalText = result.text
    const calls = result.toolCalls ?? []
    if (!calls.length || !tools.length) return { ...result, text: finalText }
    conversation = [
      ...conversation,
      { role: "assistant", content: result.text, toolCalls: calls },
    ]
    gptelFsmTransition(options.fsm, "TOOL", calls.map(call => call.name).join(", "))
    const toolExecution = await executeToolCalls(editor, deps, buffer, calls, backend, model)
    if (!toolExecution) return { ...result, text: finalText }
    options.onToolResults?.(toolExecution.calls, toolExecution.results, state(editor).tools)
    conversation.push(...toolExecution.results)
    if (toolExecution.stop) return { ...result, text: finalText }
    if (round === 0 && options.onDelta && result.text) options.onDelta("\n")
  }
  return { text: finalText }
}

function defaultChatMode(deps: GptelDeps): string {
  const custom = deps.getCustom<string>("gptel-default-mode")
  // GPTEL_CHAT_MODE is the markdown-derived chat mode (font-lock + chat keymap);
  // upstream's markdown-mode default maps onto it.
  if (!custom || custom === "markdown" || custom === "markdown-mode") return GPTEL_CHAT_MODE
  return custom.replace(/-mode$/, "")
}

function displayGptelBuffer(editor: Editor, deps: GptelDeps, buffer: BufferModel): void {
  const action = deps.getCustom<unknown>("gptel-display-buffer-action")
  if (action === "other-window" || (Array.isArray(action) && action.includes("other-window"))) {
    editor.displayBufferInOtherWindow(buffer.id, { select: true })
    return
  }
  editor.switchToBuffer(buffer.id)
}

function ensureChatBuffer(editor: Editor, deps: GptelDeps, name = GPTEL_BUFFER_PREFIX, initial?: string): BufferModel {
  const existing = [...editor.buffers.values()].find(buffer => buffer.name === name)
  if (existing) {
    displayGptelBuffer(editor, deps, existing)
    editor.enableMinorMode(GPTEL_MODE, { buffer: existing })
    return existing
  }
  const mode = defaultChatMode(deps)
  const markers = chatMarkers(deps, { mode } as BufferModel)
  const firstPrompt = `${markerText(markers, "user", true)}${initial ?? ""}`
  const buffer = editor.scratch(name, firstPrompt, mode)
  editor.enableMinorMode(GPTEL_MODE, { buffer })
  buffer.point = buffer.text.length
  displayGptelBuffer(editor, deps, buffer)
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
      if (value) setSystemMessage(deps, value)
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
    } else if (arg === "--use-context") {
      const value = args[++i]
      if (value != null) deps.setCustom("gptel-use-context", value)
    } else if (arg === "--log-level") {
      const value = args[++i]
      if (value != null) deps.setCustom("gptel-log-level", value)
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
    if (arg === "--dry-run" || arg === "-n") continue
    if (arg.startsWith("--")) {
      if (args[i + 1] && !args[i + 1]!.startsWith("--")) i++
      continue
    }
    values.push(arg)
  }
  return values
}

function promptPreset(editor: Editor, prompt: string): { name: string; prompt: string } | null {
  if (!state(editor).presets.size) return null
  const firstLineEnd = prompt.indexOf("\n")
  const firstLine = firstLineEnd >= 0 ? prompt.slice(0, firstLineEnd) : prompt
  const match = firstLine.match(/(^|[\s>])@([^\s.,;:!?()[\]{}]+)\b/)
  if (!match) return null
  const name = match[2]!
  if (!state(editor).presets.has(name)) return null
  const start = match.index! + (match[1]?.length ?? 0)
  const end = start + name.length + 1
  const strippedFirstLine = `${firstLine.slice(0, start)}${firstLine.slice(end)}`.replace(/[ \t]{2,}/g, " ").trimStart()
  return { name, prompt: `${strippedFirstLine}${firstLineEnd >= 0 ? prompt.slice(firstLineEnd) : ""}`.trimStart() }
}

async function sendFromBuffer(editor: Editor, deps: GptelDeps, buffer: BufferModel, args: string[] = [], priorVariants: string[] = []): Promise<void> {
  applyTransientArgs(editor, deps, args)
  const markers = chatMarkers(deps, buffer)
  const extracted = extractPrompt(buffer, markers)
  let prompt = orgScopedPromptForDeps(deps, buffer, extracted.prompt, extracted.end)
  if (!prompt) {
    editor.message("gptel: empty prompt")
    return
  }
  let restorePreset: (() => void) | undefined
  const token = promptPreset(editor, prompt)
  if (token) {
    const spec = presetSpec(editor, token.name)!
    const saved = new Map(presetCustomKeys(editor, spec, deps).map(name => [name, deps.getCustom(name)]))
    const applied = await applyPreset(editor, deps, token.name, false)
    if (applied) {
      prompt = token.prompt
      restorePreset = () => {
        for (const [name, value] of saved) deps.setCustom(name, value)
      }
    }
  }
  const backend = backendByName(editor, deps)
  const model = currentModel(editor, deps, backend)
  const messages = await buildMessages(editor, deps, buffer, prompt, backend, model, markers)
  const payload = requestPayload(backend, model, messages, deps, selectedTools(editor, deps))
  const fsm = gptelFsmStart(editor, deps, buffer, backend, model, payload)
  const controller = new AbortController()
  state(editor).activeRequests.set(buffer.id, controller)

  const originalPoint = buffer.point
  const followOutput = deps.getCustom<boolean>("gptel-auto-scroll") || originalPoint === buffer.text.length
  const insertionStart = buffer.text.length
  appendWritable(buffer, markerText(markers, "assistant"))
  if (!followOutput) buffer.point = originalPoint
  const responseStart = buffer.text.length
  editor.message(`gptel: ${backend.name}/${model}`)
  try {
    await editor.runHook("gptel-pre-response-hook", buffer)
    await editor.runHook("gptel-post-request-hook", buffer)
    const result = await requestWithTools(editor, deps, backend, model, messages, buffer, {
      fsm,
      signal: controller.signal,
      onToolResults(calls, results, tools) {
        fsm.toolResults = true
        insertIncludedToolResults(deps, buffer, calls, results, tools)
      },
      onReasoning(reasoning) {
        const target = reasoningBufferName(includeReasoningSetting(deps))
        if (target) appendReasoningToTarget(editor, target, reasoning)
      },
      onDelta(delta) {
        const oldPoint = buffer.point
        const wasAtEnd = buffer.point === buffer.text.length
        appendWritable(buffer, delta)
        if (followOutput || wasAtEnd) buffer.point = buffer.text.length
        else buffer.point = oldPoint
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
    const history = upsertResponseHistory(editor, buffer, {
      bufferId: buffer.id,
      start: responseStart,
      end: responseEnd,
      variants: [responseText, ...priorVariants.filter(variant => variant !== responseText)],
      variantIndex: 0,
    })
    appendWritable(buffer, markerText(markers, "user"))
    buffer.point = followOutput ? buffer.text.length : originalPoint
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
      variants: history.variants,
      variantIndex: history.variantIndex,
    }
    gptelFsmTransition(fsm, "DONE")
    editor.message(`gptel: done (${backend.name}/${model})`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    gptelFsmTransition(fsm, "ERRS", message)
    appendWritable(buffer, `${markers.separator}[gptel error] ${message}${markerText(markers, "user")}`)
    await runPostResponseFunctions(editor, buffer, backend, model, responseStart, responseStart)
    editor.message(`gptel failed: ${message}`)
  } finally {
    state(editor).activeRequests.delete(buffer.id)
    restorePreset?.()
    void editor.changed("gptel-send")
  }
}

async function inspectQueryFromBuffer(editor: Editor, deps: GptelDeps, buffer: BufferModel, args: string[], format: "json" | "object"): Promise<void> {
  applyTransientArgs(editor, deps, args)
  const markers = chatMarkers(deps, buffer)
  const extracted = extractPrompt(buffer, markers)
  let prompt = orgScopedPromptForDeps(deps, buffer, extracted.prompt, extracted.end)
  if (!prompt) {
    editor.message("gptel: empty prompt")
    return
  }
  const token = promptPreset(editor, prompt)
  if (token) {
    await gptelWithPreset(editor, token.name, async () => {
      const backend = backendByName(editor, deps)
      const model = currentModel(editor, deps, backend)
      const messages = await buildMessages(editor, deps, buffer, token.prompt, backend, model, markers)
      const payload = requestPayload(backend, model, messages, deps, selectedTools(editor, deps))
      inspectPayloadBuffer(editor, payload, format, { originBufferId: buffer.id, insertionPosition: buffer.text.length, backend: backend.name, model })
    })
    editor.message("gptel: query inspected")
    return
  }
  const backend = backendByName(editor, deps)
  const model = currentModel(editor, deps, backend)
  const messages = await buildMessages(editor, deps, buffer, prompt, backend, model, markers)
  const payload = requestPayload(backend, model, messages, deps, selectedTools(editor, deps))
  inspectPayloadBuffer(editor, payload, format, { originBufferId: buffer.id, insertionPosition: buffer.text.length, backend: backend.name, model })
  editor.message("gptel: query inspected")
}

async function continueQueryFromBuffer(editor: Editor, deps: GptelDeps, inspectBuffer: BufferModel): Promise<void> {
  const meta = inspectBuffer.locals.get(INSPECT_QUERY_META) as GptelInspectQueryMeta | undefined
  if (!meta) {
    editor.message("gptel: this is not a gptel query buffer")
    return
  }
  let payload: GptelRequestPayload
  try {
    const parsed = parseInspectQueryPayload(inspectBuffer)
    if (!parsed) throw new Error("missing query metadata")
    payload = parsed
  } catch {
    editor.message("Can not resume request: could not read data from buffer!")
    return
  }
  const target = editor.buffers.get(meta.originBufferId)
  if (!target) {
    editor.message("gptel: original buffer is gone")
    return
  }
  const backend = backendByName(editor, deps, meta.backend)
  const model = meta.model
  const markers = chatMarkers(deps, target)
  const messages = providerMessagesFromBody(backend, payload.body)
  const controller = new AbortController()
  const fsm = gptelFsmStart(editor, deps, target, backend, model, payload)
  state(editor).activeRequests.set(target.id, controller)

  const insertionStart = Math.max(0, Math.min(meta.insertionPosition, target.text.length))
  const originalPoint = target.point
  const followOutput = deps.getCustom<boolean>("gptel-auto-scroll") || originalPoint === target.text.length
  insertWritable(target, insertionStart, markerText(markers, "assistant"))
  const responseStart = insertionStart + markerText(markers, "assistant").length
  editor.switchToBuffer(target.id)
  editor.message(`gptel: ${backend.name}/${model}`)
  try {
    await editor.runHook("gptel-pre-response-hook", target)
    await editor.runHook("gptel-post-request-hook", target)
    const result = await requestWithTools(editor, deps, backend, model, messages, target, {
      fsm,
      signal: controller.signal,
      firstPayload: payload,
      tools: toolsForPayload(editor, deps, payload),
      onToolResults(calls, results, tools) {
        fsm.toolResults = true
        insertIncludedToolResults(deps, target, calls, results, tools)
      },
      onReasoning(reasoning) {
        const reasoningTarget = reasoningBufferName(includeReasoningSetting(deps))
        if (reasoningTarget) appendReasoningToTarget(editor, reasoningTarget, reasoning)
      },
      onDelta(delta) {
        insertWritable(target, target.text.length, delta)
        if (followOutput) target.point = target.text.length
        void editor.runHook("gptel-post-stream-hook", target)
      },
    })
    const insertedResponse = target.text.slice(responseStart)
    if (result.text && !insertedResponse.includes(result.text)) appendWritable(target, result.text)
    let finalResponse = await applyResponseFilters(editor, target, backend, model, target.text.slice(responseStart))
    if (shouldConvertResponseToOrg(deps, target)) finalResponse = convertMarkdownToOrg(finalResponse)
    if (finalResponse !== target.text.slice(responseStart)) replaceWritable(target, responseStart, target.text.length, finalResponse)
    const responseEnd = target.text.length
    const responseText = target.text.slice(responseStart, responseEnd)
    const st = state(editor)
    st.tokenUsage = addUsage(st.tokenUsage, result.usage)
    await runPostResponseFunctions(editor, target, backend, model, responseStart, responseEnd)
    const history = upsertResponseHistory(editor, target, {
      bufferId: target.id,
      start: responseStart,
      end: responseEnd,
      variants: [responseText],
      variantIndex: 0,
    })
    appendWritable(target, markerText(markers, "user"))
    target.point = followOutput ? target.text.length : originalPoint
    st.lastRequest = {
      bufferId: target.id,
      prompt: messages.filter(message => message.role === "user").at(-1)?.content ?? "",
      messages,
      insertionStart,
      responseStart,
      responseEnd,
      insertionEnd: target.text.length,
      backend: backend.name,
      model,
      usage: result.usage,
      variants: history.variants,
      variantIndex: history.variantIndex,
    }
    gptelFsmTransition(fsm, "DONE")
    editor.message(`gptel: done (${backend.name}/${model})`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    gptelFsmTransition(fsm, "ERRS", message)
    appendWritable(target, `${markers.separator}[gptel error] ${message}${markerText(markers, "user")}`)
    await runPostResponseFunctions(editor, target, backend, model, responseStart, responseStart)
    editor.message(`gptel failed: ${message}`)
  } finally {
    state(editor).activeRequests.delete(target.id)
    void editor.changed("gptel-continue-query")
  }
}

function copyCurlFromBuffer(editor: Editor, deps: GptelDeps, buffer: BufferModel): void {
  try {
    const payload = parseInspectQueryPayload(buffer)
    if (!payload) {
      editor.message("gptel: this is not a gptel query buffer")
      return
    }
    deps.killNew(editor, gptelCurlCommand(payload))
    editor.message("Curl command for request copied to kill-ring")
  } catch {
    editor.message("Can not copy request: could not read data from buffer!")
  }
}

function historyForVariantCommand(editor: Editor, deps: GptelDeps, buffer: BufferModel): GptelResponseHistory | null {
  const st = state(editor)
  let history = responseHistoryAtPoint(editor, deps, buffer)
  const last = st.lastRequest
  if (history && last?.bufferId === buffer.id && last.responseStart === history.start && last.responseEnd === history.end) {
    history = upsertResponseHistory(editor, buffer, {
      ...history,
      variants: last.variants.length > history.variants.length ? last.variants : history.variants,
      variantIndex: last.variantIndex,
    })
  }
  if (history) return history
  if (!last || last.bufferId !== buffer.id) return null
  return upsertResponseHistory(editor, buffer, {
    bufferId: buffer.id,
    start: last.responseStart,
    end: last.responseEnd,
    variants: last.variants,
    variantIndex: last.variantIndex,
  })
}

function syncLastRequestVariant(editor: Editor, history: GptelResponseHistory): void {
  const last = state(editor).lastRequest
  if (!last || last.bufferId !== history.bufferId) return
  if (last.responseStart !== history.start) return
  last.responseEnd = history.end
  last.insertionEnd = Math.max(last.insertionEnd, history.end)
  last.variants = history.variants
  last.variantIndex = history.variantIndex
}

function switchResponseVariant(editor: Editor, deps: GptelDeps, buffer: BufferModel, direction: number): void {
  const history = historyForVariantCommand(editor, deps, buffer)
  if (!history || history.variants.length < 2) {
    editor.message("gptel: no response variants")
    return
  }
  const nextIndex = (history.variantIndex + direction + history.variants.length) % history.variants.length
  const next = history.variants[nextIndex] ?? ""
  const oldLength = history.end - history.start
  replaceWritable(buffer, history.start, history.end, next)
  const delta = next.length - oldLength
  history.end += delta
  history.variantIndex = nextIndex
  upsertResponseHistory(editor, buffer, history)
  syncLastRequestVariant(editor, history)
  buffer.point = history.start + next.length
  editor.message(`gptel: variant ${nextIndex + 1}/${history.variants.length}`)
  void editor.changed("gptel-variant")
}

function moveResponseBoundary(editor: Editor, deps: GptelDeps, buffer: BufferModel, boundary: "start" | "end", direction: number): void {
  const markers = chatMarkers(deps, buffer)
  const ranges = responseRanges(buffer, markers)
  const current = direction >= 0
    ? ranges.find(range => (buffer.point >= range.start && buffer.point < range.end) || range[boundary] > buffer.point)
    : [...ranges].reverse().find(range => (buffer.point > range.start && buffer.point <= range.end) || range[boundary] < buffer.point)
  if (!current) {
    editor.message(`gptel: no ${direction >= 0 ? "next" : "previous"} response`)
    return
  }
  buffer.point = current[boundary]
}

function markResponse(editor: Editor, deps: GptelDeps, buffer: BufferModel): void {
  const range = responseRangeAtPoint(buffer, chatMarkers(deps, buffer))
  if (!range) {
    editor.message("gptel: no response at point")
    return
  }
  buffer.point = range.start
  buffer.mark = range.end
  buffer.markActive = true
  editor.message("gptel: marked response")
}

function markdownFenceBlockAtPoint(buffer: BufferModel): { start: number; end: number } | null {
  const line = buffer.lineAt(buffer.point)
  const [lineStart, lineEnd] = buffer.lineBounds(line)
  const lineText = buffer.text.slice(lineStart, lineEnd)
  let start: number | null = null
  let end: number | null = null
  if (/^```[ \t]*$/.test(lineText)) {
    end = lineEnd
    let parity = -1
    for (let i = line - 1; i >= 0 && parity !== 0; i--) {
      const [candidateStart, candidateEnd] = buffer.lineBounds(i)
      const candidate = buffer.text.slice(candidateStart, candidateEnd)
      if (/^```[ \t]*$/.test(candidate)) parity--
      else if (/^```[ \t]*\S+/.test(candidate)) parity++
      if (parity === 0) start = candidateStart
    }
  } else {
    let parity = 0
    let searchLine = line
    for (let i = line; i >= 0; i--) {
      const [candidateStart, candidateEnd] = buffer.lineBounds(i)
      const candidate = buffer.text.slice(candidateStart, candidateEnd)
      if (/^```[ \t]*$/.test(candidate)) parity++
      else if (/^```[ \t]*\S+/.test(candidate)) {
        if (parity === 0) {
          start = candidateStart
          searchLine = i
          break
        }
        parity--
      }
    }
    if (start != null) {
      parity = 1
      for (let i = searchLine + 1; i < buffer.lineCount && parity !== 0; i++) {
        const [candidateStart, candidateEnd] = buffer.lineBounds(i)
        const candidate = buffer.text.slice(candidateStart, candidateEnd)
        if (/^```[ \t]*$/.test(candidate)) parity--
        else if (/^```[ \t]*\S+/.test(candidate)) parity++
        if (parity === 0) end = candidateEnd
      }
    }
  }
  return start != null && end != null ? { start, end } : null
}

function markdownCycleBlock(editor: Editor, buffer: BufferModel): void {
  const block = markdownFenceBlockAtPoint(buffer)
  if (!block) {
    editor.message("gptel: no markdown code block at point")
    return
  }
  // Jemacs exposes render overlays, but no invisible-text/folding primitive yet.
  buffer.point = buffer.point <= block.start ? block.end : block.start
  editor.message("gptel: markdown block folding unavailable; moved to block boundary")
}

async function rewriteRegion(editor: Editor, deps: GptelDeps, buffer: BufferModel, instruction: string): Promise<void> {
  await gptelRewriteRequest(editor, deps, buffer, instruction)
}

function gptelRewriteOverlaySpans(editor: Editor, buffer: BufferModel): TextSpan[] {
  const st = state(editor)
  return st.rewriteOverlays
    .filter(rewrite => rewrite.bufferId === buffer.id)
    .map(rewrite => ({
      start: Math.max(0, Math.min(rewrite.start, buffer.text.length)),
      end: Math.max(0, Math.min(rewrite.end, buffer.text.length)),
      face: "region" as const,
      style: { bg: "#041714" },
    }))
    .filter(span => span.end > span.start)
}

function pendingRewritesForBuffer(editor: Editor, buffer: BufferModel): GptelPendingRewrite[] {
  return state(editor).rewriteOverlays.filter(rewrite => rewrite.bufferId === buffer.id)
}

function gptelRewriteOverlayAt(editor: Editor, buffer: BufferModel, point = buffer.point): GptelPendingRewrite | null {
  const rewrites = pendingRewritesForBuffer(editor, buffer)
  return rewrites.find(rewrite => point >= rewrite.start && point <= rewrite.end)
    ?? (state(editor).lastRewrite?.bufferId === buffer.id ? state(editor).lastRewrite! : null)
    ?? rewrites.at(-1)
    ?? null
}

function gptelRewriteReject(editor: Editor, buffer: BufferModel, rewrite = gptelRewriteOverlayAt(editor, buffer)): void {
  if (!rewrite) {
    editor.message("gptel-rewrite: no pending rewrite")
    return
  }
  const st = state(editor)
  st.rewriteOverlays = st.rewriteOverlays.filter(candidate => candidate.id !== rewrite.id)
  if (st.lastRewrite?.id === rewrite.id) st.lastRewrite = st.rewriteOverlays.at(-1)
  editor.message("Cleared pending LLM response(s).")
  void editor.changed("gptel--rewrite-reject")
}

function adjustPendingRewriteRanges(editor: Editor, applied: GptelPendingRewrite, delta: number): void {
  if (!delta) return
  for (const rewrite of state(editor).rewriteOverlays) {
    if (rewrite.id === applied.id || rewrite.bufferId !== applied.bufferId || rewrite.start < applied.end) continue
    rewrite.start += delta
    rewrite.end += delta
  }
}

function gptelRewriteAccept(editor: Editor, buffer: BufferModel, rewrite = gptelRewriteOverlayAt(editor, buffer)): void {
  if (!rewrite) {
    editor.message("gptel-rewrite: no pending rewrite")
    return
  }
  const target = editor.buffers.get(rewrite.bufferId)
  if (!target) {
    gptelRewriteReject(editor, buffer, rewrite)
    return
  }
  replaceWritable(target, rewrite.start, rewrite.end, rewrite.replacement)
  target.point = rewrite.start + rewrite.replacement.length
  adjustPendingRewriteRanges(editor, rewrite, rewrite.replacement.length - (rewrite.end - rewrite.start))
  gptelRewriteReject(editor, target, rewrite)
  editor.message(`Replaced region(s) with LLM output in buffer: ${editor.bufferDisplayName(target)}.`)
  void editor.changed("gptel--rewrite-accept")
}

function mergeConflictText(original: string, replacement: string): string {
  const left = original.endsWith("\n") ? original : `${original}\n`
  const right = replacement.endsWith("\n") ? replacement : `${replacement}\n`
  return `<<<<<<< original\n${left}=======\n${right}>>>>>>> replacement`
}

function gptelRewriteMerge(editor: Editor, buffer: BufferModel, rewrite = gptelRewriteOverlayAt(editor, buffer)): void {
  if (!rewrite) {
    editor.message("gptel-rewrite: no pending rewrite")
    return
  }
  const target = editor.buffers.get(rewrite.bufferId)
  if (!target) {
    gptelRewriteReject(editor, buffer, rewrite)
    return
  }
  const merged = mergeConflictText(rewrite.original, rewrite.replacement)
  replaceWritable(target, rewrite.start, rewrite.end, merged)
  target.point = rewrite.start
  adjustPendingRewriteRanges(editor, rewrite, merged.length - (rewrite.end - rewrite.start))
  gptelRewriteReject(editor, target, rewrite)
  editor.message("gptel-rewrite: inserted merge conflict")
  void editor.changed("gptel--rewrite-merge")
}

function splitDiffLines(text: string): string[] {
  if (!text) return []
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

function unifiedDiff(original: string, replacement: string, oldName = "original", newName = "replacement"): string {
  const a = splitDiffLines(original)
  const b = splitDiffLines(replacement)
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const body: string[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      body.push(` ${a[i++]}`)
    } else if (j < b.length && (i === a.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      body.push(`+${b[j++]}`)
    } else if (i < a.length) {
      body.push(`-${a[i++]}`)
    }
  }
  return [
    `--- ${oldName}`,
    `+++ ${newName}`,
    `@@ -1,${Math.max(1, a.length)} +1,${Math.max(1, b.length)} @@`,
    ...body,
    "",
  ].join("\n")
}

function gptelRewriteDiff(editor: Editor, buffer: BufferModel, rewrite = gptelRewriteOverlayAt(editor, buffer)): void {
  if (!rewrite) {
    editor.message("gptel-rewrite: no pending rewrite")
    return
  }
  const source = editor.buffers.get(rewrite.bufferId) ?? buffer
  const diff = unifiedDiff(rewrite.original, rewrite.replacement, editor.bufferDisplayName(source), `${editor.bufferDisplayName(source)}<gptel>`)
  const diffBuffer = editor.scratch("*gptel-rewrite-diff*", diff, "diff-mode")
  diffBuffer.locals.set("gptel-rewrite-id", rewrite.id)
  editor.switchToBuffer(diffBuffer.id)
}

function stripModeSuffix(mode: string): string {
  return mode.replace(/-mode$/, "")
}

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", c: "c", h: "c",
  cc: "c++", cpp: "c++", hpp: "c++", cs: "csharp", php: "php", swift: "swift",
  kt: "kotlin", scala: "scala", el: "elisp", clj: "clojure", sh: "shell", bash: "shell",
  zsh: "shell", sql: "sql", css: "css", html: "html", json: "json", yaml: "yaml",
  yml: "yaml", toml: "toml",
}

/** Buffers whose mode fell back to a generic one still deserve a language-specific
 *  rewrite directive; infer it from the visited name's extension. */
function bufferLanguage(buffer: BufferModel): string {
  const lang = stripModeSuffix(buffer.mode).toLowerCase()
  if (lang && lang !== "text" && lang !== "fundamental") return lang
  const ext = buffer.name.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase()
  return (ext && EXTENSION_LANGUAGES[ext]) || lang
}

function isProgrammingMode(mode: string): boolean {
  return /(?:typescript|javascript|python|ruby|rust|go|java|c\+\+|csharp|php|swift|kotlin|scala|elisp|lisp|scheme|clojure|shell|sh|bash|zsh|tsx|jsx|json|yaml|toml|css|html|sql)/i.test(mode)
}

function articleFor(word: string): "a" | "an" {
  return /^[aeiou]/i.test(word) ? "an" : "a"
}

function gptelRewriteDirectiveDefault(editor: Editor, deps: GptelDeps, buffer: BufferModel): string {
  for (const hook of state(editor).rewriteDirectivesHooks) {
    const value = hook({ editor, buffer })
    if (value) return value
  }
  const customHook = deps.getCustom<string>("gptel-rewrite-directives-hook")
  if (customHook && customHook.trim()) return customHook
  const configured = deps.getCustom<string>("gptel-rewrite-directive")
  if (configured && configured.trim()) return configured
  const lang = bufferLanguage(buffer)
  const article = articleFor(lang)
  if (isProgrammingMode(lang)) {
    return `You are ${article} ${lang} programmer.  Follow my instructions and refactor ${lang} code I provide.\n- Generate ONLY ${lang} code as output, without any explanation or markdown code fences.\n- Generate code in full, do not abbreviate or omit code.\n- Do not produce intermediate text or report on your progress.\n- Do not ask for further clarification, and make any assumptions you need to follow instructions.`
  }
  return `${lang ? `You are ${article} ${lang} editor.` : "You are an editor."}  Follow my instructions and improve or rewrite the text I provide.  Do not produce intermediate text or report on your progress.  Generate ONLY the replacement text, without any explanation or markdown code fences.`
}

async function rewriteMessages(editor: Editor, deps: GptelDeps, buffer: BufferModel, instruction: string, text: string, backend: GptelBackend, model: string): Promise<GptelMessage[]> {
  let system = gptelRewriteDirectiveDefault(editor, deps, buffer)
  const contextMode = deps.getCustom<boolean | string>("gptel-use-context") ?? "system"
  const useContext = contextMode !== false && contextMode !== "false" && contextMode !== "nil" && contextMode !== "no"
  const contextItems = useContext ? contextItemsForRequest(editor, buffer) : []
  const contextStringFunction = deps.getCustom<GptelContextStringFunction>("gptel-context-string-function") ?? gptelContextString
  const wrapFunction = deps.getCustom<GptelContextWrapFunction>("gptel-context-wrap-function") ?? gptelContextWrapDefault
  const context = useContext ? contextStringFunction(contextItems, editor, buffer) : ""
  if (context && contextMode === "system") system = `${system}\n\n${context}`
  let prompt = [
    text,
    "What is the required change?  I will generate only the final replacement.",
    instruction,
  ].filter(Boolean).join("\n\n")
  if (context && contextMode !== "system") prompt = wrapFunction(context, prompt, contextMode)
  prompt = await applyPromptTransforms(editor, buffer, backend, model, prompt)
  return [
    { role: "system", content: system },
    { role: "user", content: prompt },
  ]
}

function addPendingRewrite(editor: Editor, buffer: BufferModel, rewrite: Omit<GptelPendingRewrite, "id" | "bufferId">): GptelPendingRewrite {
  const pending: GptelPendingRewrite = { ...rewrite, id: `rewrite-${Date.now()}-${Math.random().toString(36).slice(2)}`, bufferId: buffer.id }
  const st = state(editor)
  st.rewriteOverlays.push(pending)
  st.lastRewrite = pending
  return pending
}

async function applyRewriteDefaultAction(editor: Editor, deps: GptelDeps, buffer: BufferModel, rewrite: GptelPendingRewrite): Promise<void> {
  const action = deps.getCustom<string | null>("gptel-rewrite-default-action")
  if (!action || action === "nil") return
  if (action === "accept") gptelRewriteAccept(editor, buffer, rewrite)
  else if (action === "merge") gptelRewriteMerge(editor, buffer, rewrite)
  else if (action === "diff" || action === "ediff") gptelRewriteDiff(editor, buffer, rewrite)
  else if (action === "dispatch") editor.openTransient(gptelRewriteDefinition(editor, deps))
}

async function gptelRewriteRequest(editor: Editor, deps: GptelDeps, buffer: BufferModel, instruction: string, options: { rewrite?: GptelPendingRewrite; dryRun?: boolean } = {}): Promise<void> {
  const bounds = regionBounds(buffer)
  if (!bounds && !options.rewrite) {
    editor.message("gptel-rewrite: mark a region first")
    return
  }
  const original = options.rewrite?.original ?? buffer.text.slice(bounds![0], bounds![1])
  const textToRewrite = options.rewrite?.replacement ?? original
  const backend = backendByName(editor, deps)
  const model = currentModel(editor, deps, backend)
  const messages = await rewriteMessages(editor, deps, buffer, instruction, textToRewrite, backend, model)
  if (options.dryRun) {
    inspectPayloadBuffer(editor, requestPayload(backend, model, messages, deps, selectedTools(editor, deps)))
    editor.message("gptel-rewrite: dry run request payload")
    return
  }
  editor.message(`gptel-rewrite: ${backend.name}/${model}`)
  const result = await requestWithTools(editor, deps, backend, model, messages, buffer)
  const replacement = result.text.trim()
  let pending: GptelPendingRewrite
  if (options.rewrite) {
    options.rewrite.replacement = replacement
    options.rewrite.instruction = instruction
    pending = options.rewrite
    state(editor).lastRewrite = pending
  } else {
    pending = addPendingRewrite(editor, buffer, {
      start: bounds![0],
      end: bounds![1],
      original,
      replacement,
      instruction,
    })
  }
  await editor.runHook("gptel-post-rewrite-functions", buffer)
  editor.message("LLM rewrite output ready: use gptel-rewrite-accept, gptel-rewrite-reject, gptel-rewrite-diff, gptel-rewrite-merge, or gptel-rewrite-iterate.")
  void editor.changed("gptel-rewrite")
  await applyRewriteDefaultAction(editor, deps, buffer, pending)
}

async function gptelRewriteIterate(editor: Editor, deps: GptelDeps, buffer: BufferModel, rewrite = gptelRewriteOverlayAt(editor, buffer), instruction?: string, dryRun = false): Promise<void> {
  if (!rewrite) {
    editor.message("gptel-rewrite: no pending rewrite")
    return
  }
  const nextInstruction = instruction ?? await editor.prompt("Rewrite instruction: ", rewrite.instruction, "gptel-rewrite")
  if (!nextInstruction) return
  const target = editor.buffers.get(rewrite.bufferId) ?? buffer
  await gptelRewriteRequest(editor, deps, target, nextInstruction, { rewrite, dryRun })
}

function acceptRewrite(editor: Editor, buffer = editor.activeBuffer): void {
  gptelRewriteAccept(editor, buffer)
}

function rejectRewrite(editor: Editor, buffer = editor.activeBuffer): void {
  gptelRewriteReject(editor, buffer)
}

function gitRootFor(path: string): string | null {
  try {
    const dir = statSync(path).isDirectory() ? path : dirname(path)
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null
  } catch {
    return null
  }
}

function gitProjectFiles(root: string): Set<string> | null {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-co", "--exclude-standard"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    return new Set(out.split(/\r?\n/).filter(Boolean).map(file => resolve(root, file)))
  } catch {
    return null
  }
}

function shouldRestrictProjectFiles(deps: GptelDeps, path: string): { skip: boolean; root?: string; rel?: string } {
  const restrict = deps.getCustom<boolean>("gptel-context-restrict-to-project-files") ?? true
  if (!restrict) return { skip: false }
  const root = gitRootFor(path)
  if (!root) return { skip: false }
  const files = gitProjectFiles(root)
  if (!files) return { skip: false }
  const full = resolve(path)
  if (files.has(full)) return { skip: false, root, rel: relative(root, full) }
  return { skip: true, root, rel: relative(root, full) }
}

function projectSkipMessage(path: string, root?: string, rel?: string): string {
  const type = existsSync(path) && statSync(path).isDirectory() ? "directory" : "file"
  const reminder = "To include it, unset `gptel-context-restrict-to-project-files'."
  if (root && rel) return `Skipping ${type} "${rel}" in project "${root}".  ${reminder}`
  return `Skipping ${type} "${path}". ${reminder}`
}

async function collectDirectory(editor: Editor, deps: GptelDeps, path: string, limit = 24): Promise<Array<{ path: string; text: string }>> {
  const files: Array<{ path: string; text: string }> = []
  async function walk(dir: string): Promise<void> {
    if (files.length >= limit) return
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (files.length >= limit || entry.name.startsWith(".") || entry.name === "node_modules") continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        const project = shouldRestrictProjectFiles(deps, full)
        if (project.skip) {
          editor.message(projectSkipMessage(full, project.root, project.rel))
          continue
        }
        const size = statSync(full).size
        const mime = mimeTypeForPath(full) ?? undefined
        if (isLikelyBinaryFile(full, size)) {
          editor.message(`Ignoring unsupported binary file "${full}".`)
          continue
        }
        const text = await readFile(full, "utf8").catch(() => "")
        files.push({ path: full, text })
      }
    }
  }
  await walk(path)
  return files
}

async function addPathContext(editor: Editor, deps: GptelDeps, path: string): Promise<void> {
  const full = resolve(path)
  const st = await stat(full)
  if (st.isDirectory()) {
    state(editor).context.push({ type: "directory", path: full, files: await collectDirectory(editor, deps, full) })
    editor.message(`gptel: added directory context ${full}`)
  } else {
    const project = shouldRestrictProjectFiles(deps, full)
    if (project.skip) {
      editor.message(projectSkipMessage(full, project.root, project.rel))
      return
    }
    const mime = mimeTypeForPath(full) ?? undefined
    const binary = isLikelyBinaryFile(full, st.size)
    const text = binary ? "" : await readFile(full, "utf8").catch(() => "")
    const item: GptelContextItem = { type: "file", path: full, text, binary, mime }
    state(editor).context.push(item)
    state(editor).gptelContextAlist.push({ source: "file", path: full, mime })
    editor.message(`gptel: added file context ${full}`)
  }
}

function installFaces(deps: GptelDeps): void {
  deps.defface("gptel-user", { fg: "#83a598", bold: true }, "gptel user prompt face.")
  deps.defface("gptel-assistant", { fg: "#b8bb26", bold: true }, "gptel assistant response face.")
  deps.defface("gptel-context", { fg: "#fabd2f" }, "gptel context face.")
  deps.defface("gptel-error", { fg: "#fb4934", bold: true }, "gptel error face.")
  deps.defface("gptel-rewrite-highlight-face", { bg: "#041714" }, "Face for highlighting regions with pending rewrites.")
  deps.defface("gptel-response-highlight", { bg: "#2a2a2a" }, "Face used to highlight gptel response regions.")
  deps.defface("gptel-response-fringe-highlight", { inherit: ["modeLine"] as any }, "Compatibility face for response fringe/margin highlights.")
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

  deps.defineMode({ name: GPTEL_QUERY_MODE, parent: "text" })
  const queryMap = new deps.Keymap("gptel-query-mode-map")
  queryMap.bind("C-c C-c", "gptel-continue-query")
  queryMap.bind("C-c C-w", "gptel-copy-curl")
  queryMap.bind("C-c C-k", "quit-window")
  deps.defineMinorMode({ name: GPTEL_QUERY_MINOR_MODE, lighter: " GPTelQuery", keymap: queryMap })

  const minorMap = new deps.Keymap("gptel-mode-map")
  minorMap.bind("C-c RET", "gptel-send")
  minorMap.bind("C-c C-c", "gptel-send")
  minorMap.bind("C-c C-r", "gptel-rewrite")
  minorMap.bind("C-c C-a", "gptel-add")
  minorMap.bind("M-p", "gptel-beginning-of-response")
  minorMap.bind("M-n", "gptel-end-of-response")
  deps.defineMinorMode({
    name: GPTEL_MODE,
    lighter: " GPTel",
    keymap: minorMap,
    onEnable(editor, buffer) {
      if (buffer) gptelUpdateStatus(editor, deps, buffer, "Ready")
    },
    onDisable(_editor, buffer) {
      buffer?.locals.delete(STATUS_LOCAL)
    },
  })
  deps.defineMinorMode({ name: "gptel-highlight-mode", lighter: "", keymap: new deps.Keymap("gptel-highlight-mode-map") })
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
    `Latest request FSM: ${st.requestFsms.at(-1)?.state ?? "(none)"}`,
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
    "  gptel-mcp-connect      activate tools from registered MCP servers",
    "  gptel-mcp-disconnect   remove MCP tools and disconnect servers",
    "  gptel-inspect-fsm      inspect recent request state machines",
    "  gptel-org-set-topic    set GPTEL_TOPIC on the current Org heading",
    "  gptel-org-set-properties save gptel options as Org properties",
    "  gptel-save-state       persist gptel metadata in this buffer",
    "  gptel-restore-state    restore gptel metadata from this buffer",
    "  gptel-abort            abort active request",
  ].join("\n")
}

function defaultDirectives(): Record<string, string> {
  return {
    default: "You are a helpful assistant.",
    concise: "You are a helpful assistant. Answer as concisely as possible.",
    shell: "Reply only with shell commands and no prose.",
    poet: "You are a poet. Reply only in verse.",
    code: "You are a careful programming assistant. Prefer small, correct patches and explain tradeoffs briefly.",
    rewrite: "You are a writing assistant. Rewrite the provided text according to the user's instruction and return only the replacement text.",
  }
}

function customDirectives(deps: GptelDeps): Record<string, string | (() => string)> {
  const raw = deps.getCustom<string | Record<string, string | (() => string)>>("gptel-directives")
  const parsed = typeof raw === "string"
    ? raw.trim() ? (() => {
      try { return JSON.parse(raw) as unknown } catch { return undefined }
    })() : undefined
    : raw
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const entries = Object.entries(parsed as Record<string, unknown>)
    .filter((entry): entry is [string, string | (() => string)] => typeof entry[1] === "string" || typeof entry[1] === "function")
  return Object.fromEntries(entries)
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === "\"" && text[i + 1] === "\"") {
        field += "\""
        i++
      } else if (ch === "\"") {
        quoted = false
      } else {
        field += ch
      }
      continue
    }
    if (ch === "\"") quoted = true
    else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else if (ch !== "\r") field += ch
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function parseCrowdsourcedPromptsCsv(text: string): Map<string, string> {
  const prompts = new Map<string, string>()
  const rows = parseCsv(text)
  for (const row of rows.slice(1)) {
    const act = row[0]?.trim()
    const prompt = row[1]?.trim()
    if (act && prompt) prompts.set(act, prompt)
  }
  return prompts
}

function gptelCrowdsourcedPrompts(editor: Editor, deps: GptelDeps): Map<string, string> {
  const st = state(editor)
  const file = deps.getCustom<string>("gptel-crowdsourced-prompts-file")
  if (!file) return new Map()
  if (st.crowdsourcedPromptsFile === file && st.crowdsourcedPrompts.size) return st.crowdsourcedPrompts
  st.crowdsourcedPromptsFile = file
  st.crowdsourcedPrompts = existsSync(file) ? parseCrowdsourcedPromptsCsv(readFileSync(file, "utf8")) : new Map()
  return st.crowdsourcedPrompts
}

function resolveDirective(value: string | (() => string)): string {
  return typeof value === "function" ? value() : value
}

function knownDirectives(editor: Editor, deps: GptelDeps): Record<string, string> {
  const directives = {
    ...defaultDirectives(),
    ...Object.fromEntries(gptelCrowdsourcedPrompts(editor, deps)),
    ...Object.fromEntries(state(editor).directives),
    ...customDirectives(deps),
  }
  return Object.fromEntries(Object.entries(directives).map(([name, value]) => [name, resolveDirective(value)]))
}

function directiveNames(editor: Editor, deps: GptelDeps): string[] {
  return Object.keys(knownDirectives(editor, deps))
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
          { key: "M+", label: "Add MCP tools", command: "gptel-mcp-connect" },
          { key: "M-", label: "Remove MCP tools", command: "gptel-mcp-disconnect" },
          { key: "RET", label: "Apply", command: "gptel-tools-apply" },
        ],
      },
    ],
  }
}

function gptelSystemPromptDefinition(editor: Editor, deps: GptelDeps): TransientDefinition {
  return {
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
        suffixes: directiveNames(editor, deps).map((name, index) => ({ key: String(index + 1), label: name, command: "gptel-system-prompt-set", args: [name] })),
      },
    ],
  }
}

function gptelRewriteDefinition(editor: Editor, deps: GptelDeps): TransientDefinition {
  return {
    name: "gptel-rewrite",
    title: "gptel rewrite",
    groups: [
      {
        title: "Rewrite",
        infixes: [
          { key: "-i", label: "Instruction", argument: "--instruction", kind: "value" },
          { key: "-n", label: "Dry run", argument: "--dry-run", kind: "toggle" },
        ],
        suffixes: [
          { key: "r", label: "Rewrite", command: "gptel-rewrite-run" },
          { key: "a", label: "Accept", command: "gptel-rewrite-accept" },
          { key: "k", label: "Reject", command: "gptel-rewrite-reject" },
          { key: "d", label: "Diff", command: "gptel-rewrite-diff" },
          { key: "m", label: "Merge", command: "gptel-rewrite-merge" },
          { key: "i", label: "Iterate", command: "gptel-rewrite-iterate" },
        ],
      },
      {
        title: "Directives",
        suffixes: directiveNames(editor, deps).map((name, index) => ({ key: String(index + 1), label: name, command: "gptel-rewrite-run", args: [name] })),
      },
    ],
  }
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
        { key: "-C", label: "Context", argument: "--use-context", kind: "value" },
        { key: "-S", label: "Schema", argument: "--schema", kind: "value" },
        { key: "-v", label: "Reasoning", argument: "--reasoning", kind: "value" },
        { key: "-l", label: "Log level", argument: "--log-level", kind: "value" },
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
        { key: "I", label: "Inspect query", command: "gptel-inspect-query" },
        { key: "J", label: "Inspect query JSON", command: "gptel-inspect-query-json" },
        { key: "L", label: "Inspect log", command: "gptel-log" },
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

export function gptelMakeGPT4All(editor: Editor, name: string, options: Partial<GptelBackend> = {}): GptelBackend {
  return gptelMakeOpenAI(editor, name, {
    protocol: "http",
    host: "localhost:4891",
    endpoint: "/api/v1/completions",
    stream: false,
    ...options,
  })
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

export const gptelMakeGhCopilot = gptelMakeGithubCopilot

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

export function gptelGetBackend(editor: Editor, name: string): GptelBackend | undefined {
  return state(editor).backends.get(name)
}

export function gptelGetTool(editor: Editor, name: string): GptelTool | undefined {
  return state(editor).tools.get(name)
}

function mcpCategory(serverName: string): string {
  return `mcp-${serverName}`
}

function mcpSafeToolName(serverName: string, toolName: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool"
  return `mcp_${safe(serverName)}_${safe(toolName)}`
}

function selectedToolNames(deps: Pick<GptelDeps, "getCustom">): string[] {
  return (deps.getCustom<string>("gptel-tools") ?? "").split(/[, ]+/).map(name => name.trim()).filter(Boolean)
}

function setSelectedToolNames(deps: Pick<GptelDeps, "setCustom">, names: string[]): void {
  deps.setCustom("gptel-tools", [...new Set(names.filter(Boolean))].join(","))
}

function mcpToolFromSpec(serverName: string, spec: GptelMcpToolSpec): GptelTool {
  return {
    name: mcpSafeToolName(serverName, spec.name),
    sourceName: spec.name,
    category: mcpCategory(serverName),
    description: spec.description ?? `MCP tool ${spec.name} from ${serverName}`,
    parameters: spec.parameters ?? { type: "object", properties: {} },
    confirm: spec.confirm,
    include: spec.include,
    async: spec.async,
    function: spec.function ?? (async () => {
      throw new Error(`gptel: MCP tool ${serverName}/${spec.name} has no callable adapter`)
    }),
  }
}

export function gptelMcpRegisterServer(editor: Editor, server: GptelMcpServer): GptelMcpServer {
  state(editor).mcpServers.set(server.name, server)
  return server
}

export function gptelMcpGetTools(editor: Editor, serverNames?: string[]): GptelTool[] {
  const st = state(editor)
  const names = serverNames?.length ? serverNames : [...st.mcpServers.keys()]
  const tools: GptelTool[] = []
  for (const name of names) {
    const server = st.mcpServers.get(name)
    if (!server || server.status === "disconnected") continue
    tools.push(...(server.tools ?? []).map(tool => mcpToolFromSpec(name, tool)))
  }
  return tools
}

export async function gptelMcpConnect(editor: Editor, deps: Pick<GptelDeps, "getCustom" | "setCustom">, serverNames?: string[]): Promise<GptelTool[]> {
  const st = state(editor)
  const names = serverNames?.length ? serverNames : [...st.mcpServers.keys()]
  if (!names.length) return []
  const activated: GptelTool[] = []
  for (const name of names) {
    const server = st.mcpServers.get(name)
    if (!server) continue
    await server.connect?.()
    server.status = "connected"
    for (const toolSpec of server.tools ?? []) {
      const tool = mcpToolFromSpec(name, toolSpec)
      st.tools.set(tool.name, tool)
      activated.push(tool)
    }
  }
  if (activated.length) setSelectedToolNames(deps, [...selectedToolNames(deps), ...activated.map(tool => tool.name)])
  return activated
}

export async function gptelMcpDisconnect(editor: Editor, deps: Pick<GptelDeps, "getCustom" | "setCustom">, serverNames?: string[]): Promise<string[]> {
  const st = state(editor)
  const names = serverNames?.length ? serverNames : [...st.mcpServers.keys()]
  const categories = new Set(names.map(mcpCategory))
  const removed: string[] = []
  for (const [name, tool] of st.tools) {
    if (tool.category && categories.has(tool.category)) {
      st.tools.delete(name)
      removed.push(name)
    }
  }
  setSelectedToolNames(deps, selectedToolNames(deps).filter(name => !removed.includes(name)))
  for (const name of names) {
    const server = st.mcpServers.get(name)
    if (!server) continue
    await server.disconnect?.()
    server.status = "disconnected"
  }
  return removed
}

export function gptelMakePreset(editor: Editor, preset: GptelPreset): GptelPreset {
  state(editor).presets.set(preset.name, preset)
  return preset
}

export function gptelMakeDirective(editor: Editor, directive: GptelDirective): GptelDirective {
  state(editor).directives.set(directive.name, directive.prompt)
  return directive
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

export function gptelAddPreToolCallFunction(editor: Editor, fn: GptelPreToolCallFunction): GptelPreToolCallFunction {
  state(editor).preToolCallFunctions.push(fn)
  return fn
}

export function gptelAddPostToolCallFunction(editor: Editor, fn: GptelPostToolCallFunction): GptelPostToolCallFunction {
  state(editor).postToolCallFunctions.push(fn)
  return fn
}

export function gptelAddRewriteDirectivesHook(editor: Editor, fn: GptelRewriteDirectivesHook): GptelRewriteDirectivesHook {
  state(editor).rewriteDirectivesHooks.push(fn)
  return fn
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPresetModifySpec(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && ["append", "prepend", "remove", "merge", "eval", "function"].some(key => hasOwn(value, key))
}

function mergeObjects(current: unknown, value: unknown): Record<string, unknown> {
  const parsedCurrent = typeof current === "string" && current.trim().startsWith("{")
    ? (() => {
      try { return JSON.parse(current) } catch { return current }
    })()
    : current
  return { ...(isPlainObject(parsedCurrent) ? parsedCurrent : {}), ...(isPlainObject(value) ? value : {}) }
}

function removeValue(current: unknown, value: unknown): unknown {
  if (typeof current === "string") {
    const needle = Array.isArray(value) ? value.join("") : String(value ?? "")
    return needle ? current.split(needle).join("") : current
  }
  if (Array.isArray(current)) {
    const removed = new Set(Array.isArray(value) ? value : [value])
    return current.filter(item => !removed.has(item))
  }
  return current
}

function appendValue(current: unknown, value: unknown): unknown {
  if (typeof current === "string" || typeof value === "string") {
    const base = String(current ?? "")
    const suffix = String(value ?? "")
    return base.endsWith(suffix) ? base : `${base}${suffix}`
  }
  return [...(Array.isArray(current) ? current : current == null ? [] : [current]), ...(Array.isArray(value) ? value : [value])]
}

function prependValue(current: unknown, value: unknown): unknown {
  if (typeof current === "string" || typeof value === "string") {
    const base = String(current ?? "")
    const prefix = String(value ?? "")
    return base.startsWith(prefix) ? base : `${prefix}${base}`
  }
  return [...(Array.isArray(value) ? value : [value]), ...(Array.isArray(current) ? current : current == null ? [] : [current])]
}

async function modifyPresetValue(current: unknown, spec: unknown): Promise<unknown> {
  if (!isPresetModifySpec(spec)) return spec
  let next = current
  for (const key of ["append", "prepend", "remove", "merge", "eval", "function"]) {
    if (!hasOwn(spec, key)) continue
    const value = spec[key]
    if (key === "append") next = appendValue(next, value)
    else if (key === "prepend") next = prependValue(next, value)
    else if (key === "remove") next = removeValue(next, value)
    else if (key === "merge") next = mergeObjects(next, value)
    else if (key === "eval") next = typeof value === "function" ? await (value as () => unknown)() : value
    else if (key === "function" && typeof value === "function") next = await (value as (current: unknown) => unknown)(next)
  }
  return next
}

function presetNames(preset: GptelPreset): Array<string | GptelPreset> {
  const parents = preset.parents
  if (!parents) return []
  return Array.isArray(parents) ? parents : [parents]
}

function presetSpec(editor: Editor, preset: string | GptelPreset): GptelPreset | undefined {
  return typeof preset === "string" ? state(editor).presets.get(preset) : preset
}

function presetKeyToCustomName(key: string): string {
  const kebab = key.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)
  return `gptel-${kebab}`
}

function selectedToolValueNames(value: unknown): string[] {
  if (typeof value === "string") return value.split(/[, ]+/).map(name => name.trim()).filter(Boolean)
  if (Array.isArray(value)) return value.flatMap(selectedToolValueNames)
  if (isPlainObject(value) && typeof value.name === "string") return [value.name]
  return []
}

function presetCustomKeys(editor: Editor, preset: GptelPreset, deps: Pick<GptelDeps, "getCustomVariable">): string[] {
  const names: string[] = []
  for (const parent of presetNames(preset)) {
    const spec = presetSpec(editor, parent)
    if (spec) names.push(...presetCustomKeys(editor, spec, deps))
  }
  for (const key of Object.keys(preset)) {
    if (["name", "description", "parents", "pre", "post"].includes(key)) continue
    if (key === "system" || key === "system-prompt" || key === "system-message") names.push("gptel-system-prompt", "gptel-system-message")
    else if (key === "rewrite-directive" || key === "rewriteDirective") names.push("gptel-rewrite-directive")
    else {
      const custom = presetKeyToCustomName(key)
      if (deps.getCustomVariable(custom)) names.push(custom)
    }
  }
  return [...new Set(names)]
}

async function applyPresetValue(editor: Editor, deps: GptelDeps, key: string, raw: unknown): Promise<void> {
  if (["description", "parents", "pre", "post", "name"].includes(key)) return
  if (key === "system" || key === "system-prompt" || key === "system-message") {
    const value = await modifyPresetValue(systemMessage(deps), raw)
    const directives = knownDirectives(editor, deps)
    const resolved = typeof value === "string" && directives[value] ? directives[value] : value
    if (typeof resolved === "string") setSystemMessage(deps, resolved)
    return
  }
  if (key === "backend") {
    const current = deps.getCustom<string>("gptel-backend")
    const value = await modifyPresetValue(current, raw)
    const backend = typeof value === "string" ? gptelGetBackend(editor, value) : value as GptelBackend | undefined
    if (!backend?.name) {
      editor.message(`gptel preset: Cannot find backend ${String(value)}`)
      return
    }
    deps.setCustom("gptel-backend", backend.name)
    return
  }
  if (key === "tools") {
    const current = selectedToolNames(deps)
    const value = await modifyPresetValue(current, raw)
    setSelectedToolNames(deps, selectedToolValueNames(value))
    return
  }
  if (key === "schema") {
    const value = await modifyPresetValue(deps.getCustom("gptel-schema"), raw)
    deps.setCustom("gptel-schema", typeof value === "string" ? value : value == null ? "" : JSON.stringify(value))
    return
  }
  const custom = key === "rewrite-directive" || key === "rewriteDirective" ? "gptel-rewrite-directive" : presetKeyToCustomName(key)
  if (!deps.getCustomVariable(custom)) {
    editor.message(`gptel preset: setting for ${key} not found, ignoring.`)
    return
  }
  deps.setCustom(custom, await modifyPresetValue(deps.getCustom(custom), raw))
}

async function applyPreset(editor: Editor, deps: GptelDeps, preset: string | GptelPreset, message = true): Promise<boolean> {
  const spec = presetSpec(editor, preset)
  if (!spec) {
    editor.message(`gptel: no preset ${typeof preset === "string" ? preset : preset.name}`)
    return false
  }
  await spec.pre?.()
  for (const parent of presetNames(spec)) {
    const ok = await applyPreset(editor, deps, parent, false)
    if (!ok) return false
  }
  for (const key of Object.keys(spec)) await applyPresetValue(editor, deps, key, spec[key])
  await spec.post?.()
  if (message) editor.message(`gptel: applied preset ${spec.name}`)
  return true
}

export async function gptelWithPreset<T>(editor: Editor, preset: string | GptelPreset, fn: () => T | Promise<T>): Promise<T> {
  const deps = await loadDeps()
  const spec = presetSpec(editor, preset)
  if (!spec) throw new Error(`gptel: no preset ${typeof preset === "string" ? preset : preset.name}`)
  const customNames = presetCustomKeys(editor, spec, deps)
  const saved = new Map(customNames.map(name => [name, deps.getCustom(name)]))
  try {
    await applyPreset(editor, deps, preset, false)
    return await fn()
  } finally {
    for (const [name, value] of saved) deps.setCustom(name, value)
  }
}

function directiveNameForSystem(editor: Editor, deps: GptelDeps, system: string): string | undefined {
  return Object.entries(knownDirectives(editor, deps)).find(([, value]) => value === system)?.[0]
}

function tsValue(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function presetSnippet(preset: GptelPreset): string {
  const lines = [
    "gptelMakePreset(editor, {",
    `  name: ${tsValue(preset.name)},`,
  ]
  for (const [key, value] of Object.entries(preset)) {
    if (key === "name" || value === undefined || value === "") continue
    const property = /^[A-Za-z_$][\w$]*$/.test(key) ? key : tsValue(key)
    lines.push(`  ${property}: ${tsValue(value)},`)
  }
  lines.push("})")
  return lines.join("\n")
}

function savePreset(editor: Editor, deps: GptelDeps, name: string, description = ""): GptelPreset {
  const system = systemMessage(deps)
  const directive = directiveNameForSystem(editor, deps, system)
  const preset: GptelPreset = {
    name,
    description: description.trim() || undefined,
    backend: deps.getCustom<string>("gptel-backend"),
    model: deps.getCustom<string>("gptel-model"),
    system: directive ?? system,
    tools: selectedToolNames(deps),
    stream: deps.getCustom<boolean>("gptel-stream") !== false,
    temperature: deps.getCustom<number | null>("gptel-temperature") ?? null,
    "max-tokens": deps.getCustom<number | null>("gptel-max-tokens") ?? null,
    "use-context": deps.getCustom<string | boolean>("gptel-use-context"),
    "track-media": deps.getCustom<boolean>("gptel-track-media") === true,
    "include-reasoning": deps.getCustom<string | boolean>("gptel-include-reasoning"),
  }
  gptelMakePreset(editor, preset)
  return preset
}

export async function install(editor: Editor): Promise<void> {
  const deps = await loadDeps()
  state(editor)
  installFaces(deps)
  installModes(deps)
  if (!editor.locals.get("gptel-rewrite-overlay-source-installed")) {
    editor.addOverlaySource(buffer => gptelRewriteOverlaySpans(editor, buffer))
    editor.locals.set("gptel-rewrite-overlay-source-installed", true)
  }
  if (!editor.locals.get("gptel-highlight-overlay-source-installed")) {
    editor.addOverlaySource(buffer => gptelHighlightSpans(deps, buffer))
    editor.locals.set("gptel-highlight-overlay-source-installed", true)
  }
  if (!editor.locals.get("gptel-mode-line-misc-installed")) {
    deps.defcustom("mode-line-misc-info", "sexp", [] as Array<(buffer: BufferModel) => string>, "Functions appended to the mode line after minor-mode lighters.", "display")
    const current = deps.getCustom<Array<(buffer: BufferModel) => string>>("mode-line-misc-info") ?? []
    const segment = (buffer: BufferModel) => buffer.minorModes.has(GPTEL_MODE) && deps.getCustom<boolean>("gptel-use-header-line") !== false
      ? ` [${gptelStatusText(editor, deps, buffer)}]`
      : ""
    ;(segment as any).gptelStatusSegment = true
    deps.setCustom("mode-line-misc-info", [
      ...current.filter(fn => !(fn as any).gptelStatusSegment),
      segment,
    ])
    editor.locals.set("gptel-mode-line-misc-installed", true)
  }

  deps.defcustom("gptel-backend", "string", "Claude", "Active gptel backend.", "gptel")
  deps.defcustom("gptel-model", "string", "claude-sonnet-4-5-20250929", "Active gptel model.", "gptel")
  deps.defcustom("gptel-api-key", "sexp", "", "Default API key used by gptel backends without an explicit key.", "gptel")
  deps.defcustom("gptel-proxy", "string", "", "HTTP proxy for upstream gptel compatibility; fetch-based Jemacs requests do not use it directly.", "gptel")
  deps.defcustom("gptel-use-curl", "boolean", false, "Curl transport toggle for upstream gptel compatibility; Jemacs uses fetch.", "gptel")
  deps.defcustom("gptel-use-header-line", "boolean", true, "Whether gptel-mode should show status information in the header-line; Jemacs falls back to mode-line misc info.", "gptel")
  deps.defcustom("gptel-system-message", "string", DEFAULT_SYSTEM_MESSAGE, "System message used for gptel requests.", "gptel")
  deps.defcustom("gptel-system-prompt", "sexp", DEFAULT_SYSTEM_MESSAGE, "Upstream-compatible alias for gptel-system-message.", "gptel")
  deps.defcustom("gptel-directives", "sexp", "", "JSON object or object of named gptel system directives.", "gptel")
  deps.defcustom("gptel-crowdsourced-prompts-file", "string", emacsCachePath("gptel-crowdsourced-prompts.csv"), "CSV cache file for crowdsourced gptel system prompts.", "gptel")
  deps.defcustom("gptel-highlight-methods", "sexp", ["face"], "Highlight methods for gptel-highlight-mode; Jemacs supports face highlighting.", "gptel")
  deps.defcustom("gptel-temperature", "sexp", null, "Sampling temperature for gptel requests, or null for the API default.", "gptel")
  deps.defcustom("gptel-max-tokens", "sexp", null, "Maximum output tokens for gptel requests, or null for the API default.", "gptel")
  deps.defcustom("gptel-num-messages-to-send", "sexp", null, "Number of prior chat messages to send, or null for all.", "gptel")
  deps.defcustom("gptel-stream", "boolean", true, "Stream gptel responses into the current buffer.", "gptel")
  deps.defcustom("gptel-log-level", "string", "", "Logging level for gptel requests: off, info, or debug.", "gptel")
  deps.defcustom("gptel-track-response", "boolean", true, "Track response metadata for upstream gptel compatibility.", "gptel")
  deps.defcustom("gptel-track-media", "boolean", false, "Track media context for upstream gptel compatibility.", "gptel")
  deps.defcustom("gptel-cache", "string", "", "Prompt caching controls: true/t for all, or space/comma separated system, tool, message.", "gptel")
  deps.defcustom("gptel-use-tools", "boolean", true, "Whether selected gptel tools are made available to models.", "gptel")
  deps.defcustom("gptel-tools", "string", "", "Comma or space separated gptel tool names to include with requests.", "gptel")
  deps.defcustom("gptel-include-tool-results", "string", "auto", "Whether tool results are inserted in gptel buffers: auto, true, or false.", "gptel")
  deps.defcustom("gptel-max-tool-rounds", "number", 3, "Maximum number of tool-call continuation rounds.", "gptel")
  deps.defcustom("gptel-confirm-tool-calls", "sexp", true, "Ask before running gptel tool calls: true, false, or auto.", "gptel")
  deps.defcustom("gptel-use-context", "string", "system", "How gptel sends context: system, user, or false.", "gptel")
  deps.defcustom("gptel-context-string-function", "sexp", gptelContextString, "Function to prepare the context string sent with gptel requests.", "gptel")
  deps.defcustom("gptel-context-wrap-function", "sexp", gptelContextWrapDefault, "Function to wrap request context around user prompts.", "gptel")
  deps.defcustom("gptel-context-restrict-to-project-files", "boolean", true, "Restrict files eligible to be added to context to project files.", "gptel")
  deps.defcustom("gptel-schema", "string", "", "Structured JSON output schema as JSON or gptel shorthand.", "gptel")
  deps.defcustom("gptel-include-reasoning", "string", "ignore", "Reasoning handling: ignore, true, false, or a buffer name.", "gptel")
  deps.defcustom("gptel-rewrite-directive", "sexp", "", "Directive used by gptel rewrite commands and presets.", "gptel")
  deps.defcustom("gptel-rewrite-directives-hook", "string", "", "Hook-like override used to generate default rewrite directives.", "gptel")
  deps.defcustom("gptel-rewrite-default-action", "sexp", null, "Action for received rewrites: nil, accept, merge, diff, ediff, or dispatch.", "gptel")
  deps.defcustom("gptel-default-mode", "string", "markdown", "Major mode for new dedicated gptel chat buffers.", "gptel")
  deps.defcustom("gptel-display-buffer-action", "sexp", "same-window", "Display hint for gptel chat buffers; supports same-window or other-window in Jemacs.", "gptel")
  deps.defcustom("gptel-prompt-prefix-alist", "sexp", defaultPromptPrefixAlist(), "Mode-specific prompt prefixes for dedicated gptel chat buffers.", "gptel")
  deps.defcustom("gptel-response-prefix-alist", "sexp", defaultResponsePrefixAlist(), "Mode-specific response prefixes for dedicated gptel chat buffers.", "gptel")
  deps.defcustom("gptel-prompt-prefix", "sexp", null, "Compatibility prompt prefix override for the current mode.", "gptel")
  deps.defcustom("gptel-response-prefix", "sexp", null, "Compatibility response prefix override for the current mode.", "gptel")
  deps.defcustom("gptel-response-separator", "string", "\n\n", "String inserted between gptel prompt and response sections.", "gptel")
  deps.defcustom("gptel-auto-scroll", "boolean", false, "Follow streaming gptel output as it arrives.", "gptel")
  deps.defcustom("gptel-pre-response-hook", "string", "", "Hook run before inserting a gptel response.", "gptel")
  deps.defcustom("gptel-post-response-functions", "string", "", "Hook run after inserting a gptel response.", "gptel")
  deps.defcustom("gptel-post-stream-hook", "string", "", "Hook run after each streaming response insertion.", "gptel")
  deps.defcustom("gptel-post-request-hook", "string", "", "Hook run after sending a gptel request.", "gptel")
  deps.defcustom("gptel-save-state-hook", "string", "", "Hook run before gptel state is saved.", "gptel")
  deps.defcustom("gptel-post-rewrite-functions", "string", "", "Hook run after a gptel rewrite is inserted.", "gptel")
  deps.defcustom("gptel-pre-tool-call-functions", "string", "", "Hook run before gptel tool calls.", "gptel")
  deps.defcustom("gptel-post-tool-call-functions", "string", "", "Hook run after gptel tool calls.", "gptel")
  deps.defcustom("gptel-org-convert-response", "boolean", true, "Convert Markdown responses to Org syntax in org-mode buffers.", "gptel")
  deps.defcustom("gptel-org-branching-context", "boolean", false, "Use heading lineage as gptel context in Org buffers.", "gptel")

  editor.command("gptel", async ({ editor, args }) => {
    const existing = [...editor.buffers.values()]
      .filter(buffer => buffer.minorModes.has(GPTEL_MODE) || buffer.mode === GPTEL_CHAT_MODE)
      .map(buffer => buffer.name)
    const backend = backendByName(editor, deps)
    const defaultName = `*${backend.name}*`
    const name = args[0] ?? await editor.completingRead("Create or choose gptel buffer: ", {
      collection: existing,
      initialValue: defaultName,
      history: "gptel-buffer",
    })
    if (!name) return
    ensureChatBuffer(editor, deps, name, args.slice(1).join(" ") || activeRegionText(editor.activeBuffer) || undefined)
  }, "Start or switch to a gptel chat buffer.")

  editor.command("gptel-add-and-open-buffer", async ({ editor, buffer }) => {
    state(editor).context.length = 0
    state(editor).gptelContextAlist.length = 0
    for (const source of editor.buffers.values()) bufferLocalContext(source).length = 0
    const source = buffer
    const region = activeRegionText(source)
    if (region) {
      const [start, end] = regionBounds(source)!
      addRegionContextItem(editor, source, start, end)
    } else {
      addBufferContextItem(editor, source)
    }
    const chat = ensureChatBuffer(editor, deps, `${GPTEL_BUFFER_PREFIX}<${Date.now()}>`)
    editor.displayBufferInOtherWindow(chat.id, { select: true })
    editor.message("gptel: added current buffer context")
  }, "Add current buffer or region to gptel context and open a chat buffer in another window.")

  editor.command("gptel-send", async ({ editor, buffer, args, prefixArgument }) => {
    if (prefixArgument != null) {
      editor.openTransient(gptelMenuDefinition)
      return
    }
    if (buffer.mode !== GPTEL_CHAT_MODE && !buffer.minorModes.has(GPTEL_MODE)) editor.enableMinorMode(GPTEL_MODE, { buffer })
    restoreGptelStateOnce(editor, deps, buffer)
    await sendFromBuffer(editor, deps, buffer, args)
  }, "Send the active region, chat prompt, or buffer prefix to the configured LLM.")

  editor.command("gptel-menu", ({ editor }) => {
    editor.openTransient(gptelMenuDefinition)
  }, "Open a compact gptel command menu.")

  editor.command("gptel-accept-tool-calls", ({ editor }) => {
    decidePendingToolCalls(editor, "accept")
  }, "Accept pending gptel tool calls.")

  editor.command("gptel-reject-tool-calls", ({ editor }) => {
    decidePendingToolCalls(editor, "reject")
  }, "Reject pending gptel tool calls.")

  editor.command("gptel-add", async ({ editor, buffer, prefixArgument }) => {
    const region = activeRegionText(buffer)
    if (prefixArgument != null && prefixArgument < 0) {
      const bounds = regionBounds(buffer)
      if (bounds) removeBufferContextInRange(editor, buffer, bounds[0], bounds[1])
      else {
        const atPoint = state(editor).context.find(item => item.type === "region" && item.bufferId === buffer.id && buffer.point >= item.start && buffer.point <= item.end)
        if (atPoint) {
          removeContextItem(editor, atPoint)
          editor.message("Context under point has been removed.")
        } else editor.message("0 contexts removed from current buffer.")
      }
      return
    }
    if (prefixArgument != null && prefixArgument > 0) {
      addBufferContextItem(editor, buffer)
      editor.message(`Buffer "${editor.bufferDisplayName(buffer)}" added to context.`)
      return
    }
    if (region) {
      const [start, end] = regionBounds(buffer)!
      addRegionContextItem(editor, buffer, start, end)
      buffer.markActive = false
      editor.message("Current region added as context.")
      return
    }
    const atPoint = state(editor).context.find(item => item.type === "region" && item.bufferId === buffer.id && buffer.point >= item.start && buffer.point <= item.end)
    if (atPoint) {
      removeContextItem(editor, atPoint)
      editor.message("Context under point has been removed.")
      return
    }
    addBufferContextItem(editor, buffer)
    editor.message(`Buffer "${editor.bufferDisplayName(buffer)}" added to context.`)
  }, "Add active region or current buffer to gptel context.")

  editor.command("gptel-context-add-current-kill", ({ editor, prefixArgument }) => {
    addCurrentKillContext(editor, deps, prefixArgument != null)
  }, "Add current kill to gptel context.")
  editor.command("gptel-add-kill", ({ editor, prefixArgument }) => {
    addCurrentKillContext(editor, deps, prefixArgument != null)
  }, "Add current kill to gptel context.")

  editor.command("gptel-add-file", async ({ editor, args }) => {
    const picked = args[0] ?? await editor.completingRead("Add file or directory: ", { completion: "file", history: "file" })
    if (!picked) return
    await addPathContext(editor, deps, picked)
  }, "Add a file or directory to gptel context.")

  editor.command("gptel-context-remove-all", ({ editor }) => {
    state(editor).context.length = 0
    state(editor).gptelContextAlist.length = 0
    for (const source of editor.buffers.values()) bufferLocalContext(source).length = 0
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
    for (const index of flagged) {
      const item = st.context[index]
      if (item) removeContextItem(editor, item)
    }
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

  editor.command("gptel-org-set-topic", async ({ editor, buffer, args }) => {
    if (buffer.mode !== "org-mode") {
      editor.message("gptel: topics are only supported in org-mode buffers")
      return
    }
    const heading = orgHeadingAt(buffer)
    if (!heading) {
      editor.message("gptel: no Org heading at point")
      return
    }
    const topic = args.join(" ") || await editor.prompt("Set topic as: ", orgTopicDefault(heading), "gptel-org-topic")
    if (!topic) return
    setOrgProperties(buffer, heading, { GPTEL_TOPIC: topic })
    editor.message(`gptel: topic ${topic}`)
  }, "Set GPTEL_TOPIC on the current Org heading.")

  editor.command("gptel-org-set-properties", async ({ editor, buffer }) => {
    if (await saveOrgGptelProperties(editor, deps, buffer)) editor.message("gptel: added configuration to current Org headline")
    else editor.message("gptel: no Org heading for properties")
  }, "Store active gptel configuration as Org properties.")

  editor.command("gptel-context-remove", ({ editor, buffer }) => {
    if (buffer.mode === GPTEL_CONTEXT_MODE) {
      const section = contextSectionAtPoint(buffer)
      if (section) {
        const item = state(editor).context[section.index]
        if (item) removeContextItem(editor, item)
        contextBuffer(editor)
        editor.message("gptel: removed context entry")
      }
      return
    }
    const st = state(editor)
    const before = st.context.length
    for (const item of [...st.context]) if (("bufferId" in item) && item.bufferId === buffer.id) removeContextItem(editor, item)
    editor.message(`gptel: removed ${before - st.context.length} context item${before - st.context.length === 1 ? "" : "s"}`)
  }, "Remove gptel context for this buffer or current context entry.")

  editor.command("gptel-rewrite", async ({ editor, buffer, args, prefixArgument }) => {
    applyTransientArgs(editor, deps, args)
    const dryRun = args.includes("--dry-run") || args.includes("-n")
    if (prefixArgument != null) {
      editor.openTransient(gptelRewriteDefinition(editor, deps))
      return
    }
    const pending = gptelRewriteOverlayAt(editor, buffer)
    if (!buffer.useRegion() && pending) {
      editor.openTransient(gptelRewriteDefinition(editor, deps))
      return
    }
    if (buffer.useRegion()) {
      const instruction = positionalArgs(args).join(" ") || await editor.prompt("Rewrite instruction: ", "Improve clarity while preserving meaning.", "gptel-rewrite")
      if (!instruction) return
      await gptelRewriteRequest(editor, deps, buffer, instruction, { dryRun })
      return
    }
    editor.openTransient(gptelRewriteDefinition(editor, deps))
  }, "Rewrite the active region using gptel.")

  editor.command("gptel-rewrite-run", async ({ editor, buffer, args }) => {
    applyTransientArgs(editor, deps, args)
    const dryRun = args.includes("--dry-run") || args.includes("-n")
    const directives = knownDirectives(editor, deps)
    const directive = positionalArgs(args).find(arg => directives[arg])
    const instruction = transientValue(args, "--instruction")
      ?? (directive ? directives[directive] : await editor.prompt("Rewrite instruction: ", "Improve clarity while preserving meaning.", "gptel-rewrite"))
    if (!instruction) return
    const pending = gptelRewriteOverlayAt(editor, buffer)
    if (pending && !buffer.useRegion()) await gptelRewriteIterate(editor, deps, buffer, pending, instruction, dryRun)
    else await gptelRewriteRequest(editor, deps, buffer, instruction, { dryRun })
  }, "Run a gptel rewrite from the rewrite transient.")

  editor.command("gptel--rewrite-accept", ({ editor, buffer }) => {
    gptelRewriteAccept(editor, buffer)
  }, "Apply the pending gptel rewrite at point.")

  editor.command("gptel--rewrite-reject", ({ editor, buffer }) => {
    gptelRewriteReject(editor, buffer)
  }, "Clear the pending gptel rewrite at point.")

  editor.command("gptel--rewrite-diff", ({ editor, buffer }) => {
    gptelRewriteDiff(editor, buffer)
  }, "Show a diff for the pending gptel rewrite at point.")

  editor.command("gptel--rewrite-ediff", ({ editor, buffer }) => {
    gptelRewriteDiff(editor, buffer)
  }, "Show a diff fallback for the pending gptel rewrite at point.")

  editor.command("gptel--rewrite-merge", ({ editor, buffer }) => {
    gptelRewriteMerge(editor, buffer)
  }, "Apply the pending gptel rewrite as a merge conflict.")

  editor.command("gptel--rewrite-iterate", async ({ editor, buffer, args }) => {
    const dryRun = args.includes("--dry-run") || args.includes("-n")
    const instruction = positionalArgs(args).join(" ") || transientValue(args, "--instruction")
    await gptelRewriteIterate(editor, deps, buffer, gptelRewriteOverlayAt(editor, buffer), instruction || undefined, dryRun)
  }, "Iterate on the pending gptel rewrite at point.")

  editor.command("gptel-rewrite-accept", ({ editor, buffer }) => {
    acceptRewrite(editor, buffer)
  }, "Accept the pending gptel rewrite at point or the last pending rewrite.")

  editor.command("gptel-rewrite-reject", ({ editor, buffer }) => {
    rejectRewrite(editor, buffer)
  }, "Reject the pending gptel rewrite at point or the last pending rewrite.")

  editor.command("gptel-rewrite-diff", ({ editor, buffer }) => {
    gptelRewriteDiff(editor, buffer)
  }, "Show a unified diff for the pending gptel rewrite.")

  editor.command("gptel-rewrite-ediff", ({ editor, buffer }) => {
    gptelRewriteDiff(editor, buffer)
  }, "Show a diff fallback for the pending gptel rewrite.")

  editor.command("gptel-rewrite-merge", ({ editor, buffer }) => {
    gptelRewriteMerge(editor, buffer)
  }, "Apply the pending gptel rewrite with conflict markers.")

  editor.command("gptel-rewrite-iterate", async ({ editor, buffer, args }) => {
    const dryRun = args.includes("--dry-run") || args.includes("-n")
    const instruction = positionalArgs(args).join(" ") || transientValue(args, "--instruction")
    await gptelRewriteIterate(editor, deps, buffer, gptelRewriteOverlayAt(editor, buffer), instruction || undefined, dryRun)
  }, "Send a follow-up rewrite instruction for the pending rewrite.")

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
    const history = upsertResponseHistory(editor, buffer, {
      bufferId: buffer.id,
      start: last.responseStart,
      end: last.responseEnd,
      variants: [currentResponse, ...last.variants.filter(variant => variant !== currentResponse)],
      variantIndex: 0,
    })
    const priorVariants = history.variants
    replaceWritable(buffer, last.insertionStart, last.insertionEnd, "")
    state(editor).responseHistories = state(editor).responseHistories.filter(item =>
      item.bufferId !== buffer.id || item.start < last.insertionStart || item.start >= last.insertionEnd)
    buffer.point = buffer.text.length
    await sendFromBuffer(editor, deps, buffer, [], priorVariants)
  }, "Regenerate the previous gptel response.")

  editor.command("gptel-previous-variant", ({ editor, buffer, args }) => {
    const count = Number(args[0] ?? 1) || 1
    switchResponseVariant(editor, deps, buffer, count)
  }, "Switch the last gptel response to the previous variant.")

  editor.command("gptel-next-variant", ({ editor, buffer, args }) => {
    const count = Number(args[0] ?? 1) || 1
    switchResponseVariant(editor, deps, buffer, -count)
  }, "Switch the last gptel response to the next variant.")

  editor.command("gptel-beginning-of-response", ({ editor, buffer, args }) => {
    const count = Math.abs(Number(args[0] ?? 1) || 1)
    for (let i = 0; i < count; i++) moveResponseBoundary(editor, deps, buffer, "start", -1)
  }, "Move point to the beginning of a gptel response.")

  editor.command("gptel-end-of-response", ({ editor, buffer, args }) => {
    const count = Math.abs(Number(args[0] ?? 1) || 1)
    for (let i = 0; i < count; i++) moveResponseBoundary(editor, deps, buffer, "end", 1)
  }, "Move point to the end of a gptel response.")

  editor.command("gptel-mark-response", ({ editor, buffer }) => {
    markResponse(editor, deps, buffer)
  }, "Mark the gptel response at point.")

  editor.command("gptel-copy-last-response", ({ editor, buffer }) => {
    const response = lastAssistantResponse(buffer, chatMarkers(deps, buffer))
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

  editor.command("gptel-save-preset", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Save gptel settings to preset: ", { collection: [...state(editor).presets.keys()], history: "gptel-preset" })
    if (!name) return
    const description = args[1] ?? await editor.prompt("Description (optional): ", "", "gptel-preset-description") ?? ""
    const preset = savePreset(editor, deps, name, description)
    const snippet = presetSnippet(preset)
    deps.killNew(editor, snippet)
    const bufferName = `*gptel preset ${name}*`
    const existing = [...editor.buffers.values()].find(buffer => buffer.name === bufferName)
    const buffer = existing ?? editor.scratch(bufferName, "", "typescript")
    buffer.setText(snippet)
    editor.switchToBuffer(buffer.id)
    editor.message(`gptel: preset ${name} saved`)
  }, "Save current gptel settings as a preset.")

  editor.command("gptel-system-prompt", ({ editor }) => {
    editor.openTransient(gptelSystemPromptDefinition(editor, deps))
  }, "Open the gptel system prompt transient.")

  editor.command("gptel-system-prompt-set", async ({ editor, args }) => {
    applyTransientArgs(editor, deps, args)
    const directives = knownDirectives(editor, deps)
    const directive = positionalArgs(args).find(arg => directives[arg])
    const promptFromArgs = transientValue(args, "--system")
    const prompt = directive
      ? directives[directive]
      : promptFromArgs ?? await editor.prompt("System prompt: ", systemMessage(deps), "gptel-system")
    if (prompt != null) setSystemMessage(deps, prompt)
    editor.message("gptel: system prompt set")
  }, "Set the gptel system prompt.")

  editor.command("gptel-refresh-crowdsourced-prompts", async ({ editor }) => {
    const file = deps.getCustom<string>("gptel-crowdsourced-prompts-file")
    if (!file) {
      editor.message("gptel: no crowdsourced prompts file configured")
      return
    }
    const response = await fetch(CROWDSOURCED_PROMPTS_URL)
    if (!response.ok) throw new Error(`gptel crowdsourced prompts ${response.status}: ${response.statusText}`)
    const text = await response.text()
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, text, "utf8")
    const st = state(editor)
    st.crowdsourcedPromptsFile = file
    st.crowdsourcedPrompts = parseCrowdsourcedPromptsCsv(text)
    editor.message(`gptel: loaded ${st.crowdsourcedPrompts.size} crowdsourced prompts`)
  }, "Fetch and cache crowdsourced gptel system prompts.")

  editor.command("gptel-status", ({ editor, buffer }) => {
    editor.message(`gptel: ${gptelStatusText(editor, deps, buffer)}`)
  }, "Show gptel status for the current buffer.")

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

  editor.command("gptel-mcp-connect", async ({ editor, args }) => {
    const added = await gptelMcpConnect(editor, deps, args.length ? args : undefined)
    editor.message(added.length
      ? `gptel: added ${added.length} MCP tool${added.length === 1 ? "" : "s"}`
      : "gptel: no MCP tools added")
  }, "Register and activate tools from configured MCP servers.")

  editor.command("gptel-mcp-disconnect", async ({ editor, args }) => {
    const removed = await gptelMcpDisconnect(editor, deps, args.length ? args : undefined)
    editor.message(removed.length
      ? `gptel: removed ${removed.length} MCP tool${removed.length === 1 ? "" : "s"}`
      : "gptel: no MCP tools removed")
  }, "Remove MCP tools from gptel and disconnect their servers.")

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

  editor.command("gptel-markdown-cycle-block", ({ editor, buffer }) => {
    markdownCycleBlock(editor, buffer)
  }, "Upstream-compatible placeholder for cycling Markdown block visibility.")

  editor.command("gptel-inspect", ({ editor }) => {
    editor.scratch("*gptel*", describeState(editor, deps), "text")
  }, "Inspect gptel state.")

  editor.command("gptel-inspect-query", async ({ editor, buffer, args }) => {
    await inspectQueryFromBuffer(editor, deps, buffer, args, "object")
  }, "Dry-run the current gptel request and inspect the request object.")

  editor.command("gptel-inspect-query-json", async ({ editor, buffer, args }) => {
    await inspectQueryFromBuffer(editor, deps, buffer, args, "json")
  }, "Dry-run the current gptel request and inspect the JSON body.")

  editor.command("gptel-continue-query", async ({ editor, buffer }) => {
    await continueQueryFromBuffer(editor, deps, buffer)
  }, "Continue a gptel request from an editable inspect-query buffer.")

  editor.command("gptel-copy-curl", ({ editor, buffer }) => {
    copyCurlFromBuffer(editor, deps, buffer)
  }, "Copy a Curl command for the gptel inspect-query buffer.")

  editor.command("gptel-inspect-fsm", ({ editor }) => {
    const buffer = editor.scratch("*gptel-diagnostic*", gptelFsmInspectText(editor), "text")
    buffer.readOnly = true
  }, "Inspect recent and active gptel request FSM states.")

  editor.command("gptel-log", ({ editor }) => {
    const buffer = logBuffer(editor, "")
    editor.switchToBuffer(buffer.id)
  }, "Open the gptel log buffer.")

  editor.command("gptel-save-state", async ({ editor, buffer }) => {
    if (await saveOrgGptelProperties(editor, deps, buffer)) editor.message("gptel: org state saved")
    else {
      await saveGptelState(editor, deps, buffer)
      editor.message("gptel: state saved")
    }
  }, "Persist gptel state in the current buffer.")

  editor.command("gptel-restore-state", ({ editor, buffer }) => {
    editor.message(
      restoreOrgGptelProperties(editor, deps, buffer) || restoreGptelState(editor, deps, buffer)
        ? "gptel: state restored"
        : "gptel: no saved state",
    )
  }, "Restore gptel state from the current buffer.")

  editor.defineKey("global", "s-m", "gptel-menu")
  editor.defineKey("global", "s-g", "gptel")
  editor.defineKey("global", "s-l", "gptel-add-and-open-buffer")
}
