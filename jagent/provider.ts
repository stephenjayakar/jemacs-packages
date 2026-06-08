import type {
  JagentBuiltInProviderName,
  JagentCompletion,
  JagentCustomProvider,
  JagentMessage,
  JagentMockResponse,
  JagentProviderKind,
  JagentProviderName,
  JagentSettings,
  JagentToolCall,
  JagentToolName,
} from "./types"

type AiSdkToolCall = {
  toolCallId?: string
  id?: string
  toolName?: string
  name?: string
  input?: unknown
  args?: unknown
}

type AiSdkGenerateTextResult = {
  text?: string
  toolCalls?: AiSdkToolCall[]
  staticToolCalls?: AiSdkToolCall[]
  dynamicToolCalls?: AiSdkToolCall[]
  response?: {
    modelId?: string
  }
}

export const DEFAULT_SYSTEM_PROMPT = `You are Jagent for Jemacs: a pragmatic coding agent running inside the editor.

Work directly on the user's project. Use tools when you need current file contents, searches, edits, or command output.
Prefer small, verifiable changes. For shell work, use bash. Keep responses concise and mention files changed.

Tool rules:
- read_file before editing a file unless the user supplied the contents.
- edit_file requires exact oldText and replaces one occurrence.
- use bash for tests, builds, git inspection, and terminal-native programs.
- do not claim a command succeeded unless the tool result says it did.`

const TOOL_NAMES = new Set<JagentToolName>([
  "read_file",
  "write_file",
  "edit_file",
  "list_files",
  "grep",
  "bash",
])

const BUILT_IN_PROVIDERS = new Set<JagentBuiltInProviderName>([
  "gemini",
  "openai",
  "anthropic",
  "mock",
])

export type ResolvedJagentProvider = {
  name: string
  kind: JagentProviderKind
  model: string
  label: string
  apiKey?: string
  baseURL?: string
  headers?: Record<string, string>
  systemPrompt: string
  mockResponses?: JagentMockResponse[]
}

function isBuiltInProvider(name: string): name is JagentBuiltInProviderName {
  return BUILT_IN_PROVIDERS.has(name as JagentBuiltInProviderName)
}

function providerUsable(settings: JagentSettings, name: string, spec?: JagentCustomProvider): boolean {
  const kind = providerKind(name, spec)
  if (kind === "mock") return true
  if (spec?.apiKey) return true
  if (spec?.apiKeyEnv && process.env[spec.apiKeyEnv]) return true
  if (kind === "openai-compatible" && spec?.baseURL) return true
  if (kind === "gemini") return Boolean(settings.apiKeys.gemini)
  if (kind === "openai") return Boolean(settings.apiKeys.openai)
  if (kind === "anthropic") return Boolean(settings.apiKeys.anthropic)
  return false
}

function activeProviderName(settings: JagentSettings): string {
  if (settings.provider !== "auto") return settings.provider
  if (settings.defaultProvider !== "auto") return settings.defaultProvider
  if (settings.apiKeys.gemini) return "gemini"
  if (settings.apiKeys.openai) return "openai"
  if (settings.apiKeys.anthropic) return "anthropic"
  for (const [name, spec] of Object.entries(settings.customProviders)) {
    if (providerUsable(settings, name, spec)) return name
  }
  throw new Error("No Jagent provider configured. Set a default provider, API key, custom provider, or use provider `mock`.")
}

function defaultModel(provider: JagentProviderKind): string {
  switch (provider) {
    case "gemini": return "gemini-2.5-flash"
    case "openai": return "gpt-4.1-mini"
    case "anthropic": return "claude-sonnet-4-5"
    case "mock": return "mock"
    case "openai-compatible": return "model"
  }
}

function providerKind(name: string, spec?: JagentCustomProvider): JagentProviderKind {
  if (spec?.kind) return spec.kind
  if (isBuiltInProvider(name)) return name
  return "openai-compatible"
}

function providerApiKey(settings: JagentSettings, name: string, kind: JagentProviderKind, spec?: JagentCustomProvider): string {
  if (spec?.apiKey) return spec.apiKey
  if (spec?.apiKeyEnv && process.env[spec.apiKeyEnv]) return process.env[spec.apiKeyEnv] ?? ""
  if (kind === "gemini") return settings.apiKeys.gemini
  if (kind === "openai" || kind === "openai-compatible") return settings.apiKeys.openai
  if (kind === "anthropic") return settings.apiKeys.anthropic
  return name === "mock" ? "mock" : ""
}

function providerDefaultModel(settings: JagentSettings, kind: JagentProviderKind, spec?: JagentCustomProvider): string {
  return spec?.defaultModel || settings.defaultModel || defaultModel(kind)
}

function resolveSystemPrompt(
  settings: JagentSettings,
  name: string,
  kind: JagentProviderKind,
  model: string,
  spec?: JagentCustomProvider,
): string {
  return spec?.modelSystemPrompts?.[model]
    ?? settings.modelSystemPrompts[`${name}/${model}`]
    ?? settings.modelSystemPrompts[`${kind}/${model}`]
    ?? settings.modelSystemPrompts[model]
    ?? spec?.systemPrompt
    ?? settings.providerSystemPrompts[name]
    ?? settings.providerSystemPrompts[kind]
    ?? settings.systemPrompt
    ?? DEFAULT_SYSTEM_PROMPT
}

export function resolveJagentProvider(settings: JagentSettings): ResolvedJagentProvider {
  const name = activeProviderName(settings)
  const spec = settings.customProviders[name]
  const kind = providerKind(name, spec)
  const model = settings.model || providerDefaultModel(settings, kind, spec)
  const apiKey = providerApiKey(settings, name, kind, spec)

  if (kind !== "mock" && kind !== "openai-compatible" && !apiKey) {
    const upper = kind.toUpperCase()
    throw new Error(`No API key for ${name}. Set jagent-${kind}-api-key, ${upper}_API_KEY, or a custom provider apiKey/apiKeyEnv.`)
  }

  return {
    name,
    kind,
    model,
    label: `${name}/${model}`,
    apiKey,
    baseURL: spec?.baseURL,
    headers: spec?.headers,
    systemPrompt: resolveSystemPrompt(settings, name, kind, model, spec),
    mockResponses: spec?.mockResponses ?? settings.mockResponses,
  }
}

export function describeJagentSettings(settings: JagentSettings): string {
  try {
    return resolveJagentProvider(settings).label
  } catch {
    const provider = settings.provider !== "auto"
      ? settings.provider
      : settings.defaultProvider !== "auto"
        ? settings.defaultProvider
        : "auto"
    return `${provider}/${settings.model || settings.defaultModel || "default"}`
  }
}

export function serializeTranscript(messages: JagentMessage[], systemPrompt = DEFAULT_SYSTEM_PROMPT): string {
  const lines = [systemPrompt, "", "Conversation so far:"]
  for (const message of messages) {
    if (message.role === "user") {
      lines.push("", "User:", message.content)
    } else if (message.role === "assistant") {
      lines.push("", "Assistant:", message.content || "(requested tool calls)")
      if (message.toolCalls?.length) {
        lines.push("Tool calls:", JSON.stringify(message.toolCalls, null, 2))
      }
    } else {
      lines.push("", `Tool result (${message.result.name}, ${message.result.ok ? "ok" : "error"}):`, message.result.output)
    }
  }
  return lines.join("\n")
}

function lastUserPrompt(messages: JagentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === "user") return message.content
  }
  return ""
}

function mockResponse(messages: JagentMessage[], responses: JagentMockResponse[]): Exclude<JagentMockResponse, string> {
  const assistantTurns = messages.filter(message => message.role === "assistant").length
  const response = responses[Math.min(assistantTurns, Math.max(0, responses.length - 1))]
  if (typeof response === "string") return { content: response }
  return response ?? { content: `Mock response to: ${lastUserPrompt(messages)}` }
}

function mockGenerateResult(resolved: ResolvedJagentProvider, messages: JagentMessage[]): unknown {
  const response = mockResponse(messages, resolved.mockResponses ?? [])
  const toolCalls = response.toolCalls ?? []
  return {
    content: [
      ...(response.content ? [{ type: "text", text: response.content }] : []),
      ...toolCalls.map(call => ({
        type: "tool-call",
        toolCallId: call.id,
        toolName: call.name,
        input: JSON.stringify(call.args ?? {}),
      })),
    ],
    finishReason: { unified: toolCalls.length ? "tool-calls" : "stop", raw: undefined },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 0, text: 0, reasoning: undefined },
      totalTokens: 0,
    },
    response: { modelId: response.model ?? resolved.label },
    warnings: [],
  }
}

async function languageModel(resolved: ResolvedJagentProvider, messages: JagentMessage[]): Promise<{ model: unknown; label: string }> {
  if (resolved.kind === "mock") {
    const { MockLanguageModelV3 } = await import("ai/test")
    return {
      model: new MockLanguageModelV3({
        provider: resolved.name,
        modelId: resolved.model,
        doGenerate: async () => mockGenerateResult(resolved, messages) as never,
      }),
      label: resolved.label,
    }
  }

  const options: Record<string, unknown> = {}
  if (resolved.apiKey) options.apiKey = resolved.apiKey
  else if (resolved.kind === "openai-compatible") options.apiKey = "unused"
  if (resolved.baseURL) options.baseURL = resolved.baseURL
  if (resolved.headers) options.headers = resolved.headers

  if (resolved.kind === "gemini") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google")
    const google = createGoogleGenerativeAI(options as never)
    return { model: google(resolved.model), label: resolved.label }
  }

  if (resolved.kind === "openai" || resolved.kind === "openai-compatible") {
    const { createOpenAI } = await import("@ai-sdk/openai")
    const openai = createOpenAI(options as never)
    return { model: openai(resolved.model), label: resolved.label }
  }

  const { createAnthropic } = await import("@ai-sdk/anthropic")
  const anthropic = createAnthropic(options as never)
  return { model: anthropic(resolved.model), label: resolved.label }
}

async function jagentTools(): Promise<Record<JagentToolName, unknown>> {
  const [{ tool }, { z }] = await Promise.all([
    import("ai"),
    import("zod"),
  ])

  return {
    read_file: tool({
      description: "Read a UTF-8 text file.",
      inputSchema: z.object({
        path: z.string().describe("File path, absolute or relative to the project."),
        maxChars: z.number().optional().describe("Optional maximum characters to return."),
      }),
    }),
    write_file: tool({
      description: "Write a UTF-8 text file, creating parent directories.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
    }),
    edit_file: tool({
      description: "Replace exact text in a UTF-8 text file.",
      inputSchema: z.object({
        path: z.string(),
        oldText: z.string(),
        newText: z.string(),
      }),
    }),
    list_files: tool({
      description: "List files below a directory.",
      inputSchema: z.object({
        path: z.string().optional().describe("Directory path. Defaults to project root."),
        maxEntries: z.number().optional(),
      }),
    }),
    grep: tool({
      description: "Search text with ripgrep-style behavior.",
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional().describe("File or directory. Defaults to project root."),
        maxMatches: z.number().optional(),
      }),
    }),
    bash: tool({
      description: "Run a shell command in the managed jterm terminal.",
      inputSchema: z.object({
        command: z.string(),
        timeoutMs: z.number().optional(),
      }),
    }),
  }
}

function normalizeToolCall(call: AiSdkToolCall, index: number): JagentToolCall | null {
  const name = (call.toolName ?? call.name) as JagentToolName
  if (!TOOL_NAMES.has(name)) return null
  const input = call.input ?? call.args ?? {}
  return {
    id: call.toolCallId ?? call.id ?? `tool-${Date.now()}-${index}`,
    name,
    args: normalizeToolArgs(input),
  }
}

function normalizeToolArgs(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      return { input }
    }
  }
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : { input }
}

function uniqueToolCalls(result: AiSdkGenerateTextResult): JagentToolCall[] {
  const raw = [
    ...(result.toolCalls ?? []),
    ...(result.staticToolCalls ?? []),
    ...(result.dynamicToolCalls ?? []),
  ]
  const seen = new Set<string>()
  const out: JagentToolCall[] = []
  raw.forEach((call, index) => {
    const normalized = normalizeToolCall(call, index)
    if (!normalized || seen.has(normalized.id)) return
    seen.add(normalized.id)
    out.push(normalized)
  })
  return out
}

export async function completeWithTools(
  settings: JagentSettings,
  messages: JagentMessage[],
  signal?: AbortSignal,
): Promise<JagentCompletion> {
  const resolved = resolveJagentProvider(settings)

  const [{ generateText }, model, tools] = await Promise.all([
    import("ai"),
    languageModel(resolved, messages),
    jagentTools(),
  ])

  const result = await generateText({
    model: model.model as never,
    prompt: serializeTranscript(messages, resolved.systemPrompt),
    tools: tools as never,
    abortSignal: signal,
  }) as AiSdkGenerateTextResult

  return {
    content: result.text ?? "",
    toolCalls: uniqueToolCalls(result),
    model: result.response?.modelId ?? model.label,
  }
}
