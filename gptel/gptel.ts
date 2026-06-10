import { existsSync, readFileSync, statSync } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
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
}

export type GptelBackendKind =
  | "openai"
  | "openai-responses"
  | "anthropic"
  | "gemini"
  | "ollama"
  | "kagi"
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
}

export type GptelContextItem =
  | { type: "buffer"; name: string; bufferId: string; text: string }
  | { type: "region"; name: string; bufferId: string; start: number; end: number; text: string }
  | { type: "file"; path: string; text: string; binary?: boolean }
  | { type: "directory"; path: string; files: Array<{ path: string; text: string }> }
  | { type: "text"; name: string; text: string }

export type GptelTool = {
  name: string
  description: string
  parameters?: unknown
  function: (args: unknown, ctx: { editor: Editor; buffer: BufferModel }) => unknown | Promise<unknown>
}

export type GptelPreset = {
  name: string
  description?: string
  backend?: string
  model?: string
  system?: string
  temperature?: number
  tools?: string[]
}

type GptelState = {
  backends: Map<string, GptelBackend>
  tools: Map<string, GptelTool>
  presets: Map<string, GptelPreset>
  context: GptelContextItem[]
  activeRequests: Map<string, AbortController>
  lastRequest?: {
    bufferId: string
    prompt: string
    messages: GptelMessage[]
    insertionStart: number
    insertionEnd: number
    backend: string
    model: string
  }
}

type RequestResult = {
  text: string
  raw?: unknown
  usage?: Record<string, unknown>
}

const STATE_KEY = "gptel-state"
const GPTEL_MODE = "gptel-mode"
const GPTEL_CHAT_MODE = "gptel-chat"
const GPTEL_BUFFER_PREFIX = "*ChatGPT*"
const RESPONSE_BEGIN = "\n\nAssistant:\n"
const USER_BEGIN = "\n\nUser:\n"

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
    context: [],
    activeRequests: new Map(),
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

function backendUrl(backend: GptelBackend, model: string): string {
  const protocol = backend.protocol ?? "https"
  const host = backend.host ?? "api.openai.com"
  const endpoint = (backend.endpoint ?? "/v1/chat/completions").replace("{model}", encodeURIComponent(model))
  if (/^https?:\/\//.test(endpoint)) return endpoint
  return `${protocol}://${host}${endpoint}`
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

export function extractPrompt(buffer: BufferModel): { prompt: string; start: number; end: number } {
  const bounds = regionBounds(buffer)
  if (bounds) return { prompt: buffer.text.slice(bounds[0], bounds[1]).trim(), start: bounds[0], end: bounds[1] }
  if (buffer.mode === GPTEL_CHAT_MODE || buffer.minorModes.has(GPTEL_MODE)) {
    const beforePoint = buffer.text.slice(0, buffer.point)
    const user = beforePoint.lastIndexOf("User:\n")
    const assistant = beforePoint.lastIndexOf("Assistant:\n")
    const start = user >= 0 && user > assistant ? user + "User:\n".length : 0
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

function chatHistory(buffer: BufferModel): GptelMessage[] {
  const messages: GptelMessage[] = []
  const regex = /(?:^|\n\n)(User|Assistant):\n([\s\S]*?)(?=\n\n(?:User|Assistant):\n|$)/g
  for (const match of buffer.text.matchAll(regex)) {
    const role = match[1] === "User" ? "user" : "assistant"
    const content = (match[2] ?? "").trim()
    if (content) messages.push({ role, content })
  }
  return messages
}

function lastAssistantResponse(buffer: BufferModel): string | null {
  const messages = chatHistory(buffer).filter(message => message.role === "assistant")
  return messages.at(-1)?.content ?? null
}

function buildMessages(editor: Editor, deps: GptelDeps, buffer: BufferModel, prompt: string): GptelMessage[] {
  const messages: GptelMessage[] = []
  const system = deps.getCustom<string>("gptel-system-message") || "You are a helpful assistant."
  if (system) messages.push({ role: "system", content: system })
  const context = renderContext(state(editor).context)
  const history = (buffer.mode === GPTEL_CHAT_MODE || buffer.minorModes.has(GPTEL_MODE)) ? chatHistory(buffer) : []
  messages.push(...history.slice(0, -1))
  const promptWithContext = context ? `${context}\n\nUser request:\n${prompt}` : prompt
  messages.push({ role: "user", content: promptWithContext })
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

function requestBody(backend: GptelBackend, model: string, messages: GptelMessage[], deps: GptelDeps, stream: boolean): unknown {
  const temperature = deps.getCustom<number>("gptel-temperature")
  const maxTokens = deps.getCustom<number>("gptel-max-tokens")
  if (backend.kind === "anthropic") {
    const system = messages.find(m => m.role === "system")?.content
    return {
      model,
      max_tokens: maxTokens || 4096,
      temperature: temperature || undefined,
      stream,
      system,
      messages: messages.filter(m => m.role !== "system").map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    }
  }
  if (backend.kind === "gemini") {
    return {
      contents: messages.filter(m => m.role !== "system").map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      systemInstruction: messages.find(m => m.role === "system") ? { parts: [{ text: messages.find(m => m.role === "system")!.content }] } : undefined,
      generationConfig: {
        temperature: temperature || undefined,
        maxOutputTokens: maxTokens || undefined,
      },
    }
  }
  if (backend.kind === "ollama") {
    return { model, stream, messages: messages.map(m => ({ role: m.role, content: m.content })) }
  }
  if (backend.kind === "openai-responses") {
    return {
      model,
      stream,
      input: messages.map(m => ({ role: m.role === "system" ? "developer" : m.role, content: m.content })),
      temperature: temperature || undefined,
      max_output_tokens: maxTokens || undefined,
    }
  }
  return {
    model,
    stream,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    temperature: temperature || undefined,
    max_tokens: maxTokens || undefined,
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
  } else if (key) {
    headers.authorization = `Bearer ${key}`
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

function textFromJson(backend: GptelBackend, json: unknown): string {
  const data = json as Record<string, any>
  if (backend.kind === "anthropic") {
    return data.content?.map((part: any) => part.text ?? "").join("") ?? ""
  }
  if (backend.kind === "gemini") {
    return data.candidates?.flatMap((c: any) => c.content?.parts ?? []).map((p: any) => p.text ?? "").join("") ?? ""
  }
  if (backend.kind === "ollama") return data.message?.content ?? data.response ?? ""
  if (backend.kind === "openai-responses") {
    return data.output_text ?? data.output?.flatMap((o: any) => o.content ?? []).map((c: any) => c.text ?? "").join("") ?? ""
  }
  return data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? ""
}

function textFromStreamEvent(backend: GptelBackend, data: string): string {
  if (!data || data === "[DONE]") return ""
  let json: any
  try { json = JSON.parse(data) } catch { return "" }
  if (backend.kind === "anthropic") {
    if (json.type === "content_block_delta") return json.delta?.text ?? ""
    if (json.type === "message_delta") return ""
  }
  if (backend.kind === "gemini") {
    return json.candidates?.flatMap((c: any) => c.content?.parts ?? []).map((p: any) => p.text ?? "").join("") ?? ""
  }
  if (backend.kind === "ollama") return json.message?.content ?? json.response ?? ""
  if (backend.kind === "openai-responses") {
    if (json.type === "response.output_text.delta") return json.delta ?? ""
    if (json.type === "response.refusal.delta") return json.delta ?? ""
  }
  return json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.text ?? ""
}

async function requestLlm(
  editor: Editor,
  deps: GptelDeps,
  backend: GptelBackend,
  model: string,
  messages: GptelMessage[],
  options: { onDelta?: (delta: string) => void; signal?: AbortSignal } = {},
): Promise<RequestResult> {
  if (backend.kind === "mock") {
    const response = `Mock response to: ${messages.at(-1)?.content ?? ""}`
    for (const token of response.match(/.{1,16}/g) ?? []) {
      options.onDelta?.(token)
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    return { text: response }
  }

  const stream = backend.stream !== false && deps.getCustom<boolean>("gptel-stream") !== false
  const response = await fetch(backendUrl(backend, model), {
    method: "POST",
    headers: requestHeaders(backend),
    body: JSON.stringify(requestBody(backend, model, messages, deps, stream)),
    signal: options.signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`${backend.name} ${response.status}: ${body || response.statusText}`)
  }
  if (!stream || !response.body) {
    const json = await response.json()
    return { text: textFromJson(backend, json), raw: json }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    const complete = pending.split(/\n\n+/)
    pending = complete.pop() ?? ""
    for (const event of parseSseEvents(complete.join("\n\n"))) {
      const delta = textFromStreamEvent(backend, event)
      if (!delta) continue
      text += delta
      options.onDelta?.(delta)
      void editor.changed("gptel-stream")
    }
  }
  for (const event of parseSseEvents(pending)) {
    const delta = textFromStreamEvent(backend, event)
    text += delta
    options.onDelta?.(delta)
  }
  return { text }
}

function ensureChatBuffer(editor: Editor, name = GPTEL_BUFFER_PREFIX): BufferModel {
  const existing = [...editor.buffers.values()].find(buffer => buffer.name === name)
  if (existing) {
    editor.switchToBuffer(existing.id)
    editor.enterMode(existing, GPTEL_CHAT_MODE)
    return existing
  }
  const buffer = editor.scratch(name, "# Jemacs gptel\n\nUser:\n", GPTEL_CHAT_MODE)
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
    } else if (arg === "--no-stream") {
      deps.setCustom("gptel-stream", false)
    } else if (arg === "--stream") {
      deps.setCustom("gptel-stream", true)
    } else if (arg === "--context") {
      editor.run("gptel-context").catch(() => undefined)
    }
  }
}

async function sendFromBuffer(editor: Editor, deps: GptelDeps, buffer: BufferModel, args: string[] = []): Promise<void> {
  applyTransientArgs(editor, deps, args)
  const { prompt } = extractPrompt(buffer)
  if (!prompt) {
    editor.message("gptel: empty prompt")
    return
  }
  const backend = backendByName(editor, deps)
  const model = currentModel(editor, deps, backend)
  const messages = buildMessages(editor, deps, buffer, prompt)
  const controller = new AbortController()
  state(editor).activeRequests.set(buffer.id, controller)

  const insertionStart = buffer.text.length
  appendWritable(buffer, RESPONSE_BEGIN)
  const responseStart = buffer.text.length
  editor.message(`gptel: ${backend.name}/${model}`)
  try {
    const result = await requestLlm(editor, deps, backend, model, messages, {
      signal: controller.signal,
      onDelta(delta) {
        appendWritable(buffer, delta)
        buffer.point = buffer.text.length
      },
    })
    if (!buffer.text.slice(responseStart).trim() && result.text) appendWritable(buffer, result.text)
    appendWritable(buffer, USER_BEGIN)
    buffer.point = buffer.text.length
    state(editor).lastRequest = {
      bufferId: buffer.id,
      prompt,
      messages,
      insertionStart,
      insertionEnd: buffer.text.length,
      backend: backend.name,
      model,
    }
    editor.message(`gptel: done (${backend.name}/${model})`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendWritable(buffer, `\n\n[gptel error] ${message}${USER_BEGIN}`)
    editor.message(`gptel failed: ${message}`)
  } finally {
    state(editor).activeRequests.delete(buffer.id)
    void editor.changed("gptel-send")
  }
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
  const result = await requestLlm(editor, deps, backend, model, messages)
  const replacement = result.text.trim()
  replaceWritable(buffer, bounds[0], bounds[1], replacement)
  editor.message("gptel-rewrite: replaced region")
  void editor.changed("gptel-rewrite")
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
    const binary = st.size > 200_000
    const text = binary ? "" : await readFile(full, "utf8").catch(() => "")
    state(editor).context.push({ type: "file", path: full, text, binary })
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
  chatMap.bind("C-c C-a", "gptel-add")
  chatMap.bind("C-c C-n", "gptel-context-remove-all")
  deps.defineMode({ name: GPTEL_CHAT_MODE, parent: "markdown", keymap: chatMap, fontLock: gptelFontLock })

  const minorMap = new deps.Keymap("gptel-mode-map")
  minorMap.bind("C-c RET", "gptel-send")
  minorMap.bind("C-c C-c", "gptel-send")
  minorMap.bind("C-c C-r", "gptel-rewrite")
  minorMap.bind("C-c C-a", "gptel-add")
  deps.defineMinorMode({ name: GPTEL_MODE, lighter: " GPTel", keymap: minorMap })
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
    `Context items: ${st.context.length}`,
    `Presets: ${[...st.presets.keys()].join(", ") || "(none)"}`,
    `Tools: ${[...st.tools.keys()].join(", ") || "(none)"}`,
    "",
    "Commands:",
    "  gptel                  open a chat buffer",
    "  gptel-send             send region, prompt, or chat turn",
    "  gptel-add              add region/current buffer to context",
    "  gptel-add-file         add a file or directory to context",
    "  gptel-rewrite          rewrite active region",
    "  gptel-menu             inspect and change backend/model",
    "  gptel-abort            abort active request",
  ].join("\n")
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
        { key: "-S", label: "No stream", argument: "--no-stream", kind: "toggle" },
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
        { key: "y", label: "Copy response", command: "gptel-copy-last-response" },
        { key: "p", label: "Preset", command: "gptel-preset" },
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

export function gptelMakeOpenAI(editor: Editor, name: string, options: Partial<GptelBackend> = {}): GptelBackend {
  const backend = makeBackend("openai", name, { host: "api.openai.com", endpoint: "/v1/chat/completions", stream: true, ...options })
  state(editor).backends.set(name, backend)
  return backend
}

export function gptelMakeAnthropic(editor: Editor, name: string, options: Partial<GptelBackend> = {}): GptelBackend {
  const backend = makeBackend("anthropic", name, { host: "api.anthropic.com", endpoint: "/v1/messages", stream: true, ...options })
  state(editor).backends.set(name, backend)
  return backend
}

export function gptelMakeGemini(editor: Editor, name: string, options: Partial<GptelBackend> = {}): GptelBackend {
  const backend = makeBackend("gemini", name, { host: "generativelanguage.googleapis.com", endpoint: "/v1beta/models/{model}:streamGenerateContent", stream: true, ...options })
  state(editor).backends.set(name, backend)
  return backend
}

export function gptelMakeTool(editor: Editor, tool: GptelTool): GptelTool {
  state(editor).tools.set(tool.name, tool)
  return tool
}

export function gptelMakePreset(editor: Editor, preset: GptelPreset): GptelPreset {
  state(editor).presets.set(preset.name, preset)
  return preset
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

  editor.command("gptel", async ({ editor, args }) => {
    const name = args.join(" ") || GPTEL_BUFFER_PREFIX
    ensureChatBuffer(editor, name)
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
    editor.scratch("*gptel-context*", renderContext(state(editor).context) || "No gptel context.", "text")
  }, "Show current gptel context.")

  editor.command("gptel-rewrite", async ({ editor, buffer, args }) => {
    const instruction = args.join(" ") || await editor.prompt("Rewrite instruction: ", "Improve clarity while preserving meaning.", "gptel-rewrite")
    if (!instruction) return
    await rewriteRegion(editor, deps, buffer, instruction)
  }, "Rewrite the active region using gptel.")

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
    replaceWritable(buffer, last.insertionStart, last.insertionEnd, "")
    buffer.point = buffer.text.length
    await sendFromBuffer(editor, deps, buffer)
  }, "Regenerate the previous gptel response.")

  editor.command("gptel-copy-last-response", ({ editor, buffer }) => {
    const response = lastAssistantResponse(buffer)
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

  editor.command("gptel-system-prompt", async ({ editor }) => {
    const prompt = await editor.prompt("System prompt: ", deps.getCustom<string>("gptel-system-message") ?? "", "gptel-system")
    if (prompt != null) deps.setCustom("gptel-system-message", prompt)
  }, "Set the gptel system prompt.")

  editor.command("gptel-version", ({ editor }) => {
    editor.message("gptel.ts 0.9.9.5-compatible")
  }, "Show the gptel.ts compatibility version.")

  editor.command("gptel-inspect", ({ editor }) => {
    editor.scratch("*gptel*", describeState(editor, deps), "text")
  }, "Inspect gptel state.")

  editor.defineKey("global", "s-m", "gptel-menu")
  editor.defineKey("global", "s-g", "gptel")
}
