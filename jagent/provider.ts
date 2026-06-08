import type { JagentCompletion, JagentMessage, JagentProviderName, JagentSettings, JagentToolCall, JagentToolName } from "./types"

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

const SYSTEM_PROMPT = `You are Jagent for Jemacs: a pragmatic coding agent running inside the editor.

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

function resolveProvider(settings: JagentSettings): JagentProviderName {
  if (settings.provider !== "auto") return settings.provider
  if (settings.apiKeys.gemini) return "gemini"
  if (settings.apiKeys.openai) return "openai"
  if (settings.apiKeys.anthropic) return "anthropic"
  throw new Error("No API key. Set GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.")
}

function defaultModel(provider: JagentProviderName): string {
  switch (provider) {
    case "gemini": return "gemini-2.5-flash"
    case "openai": return "gpt-4.1-mini"
    case "anthropic": return "claude-sonnet-4-5"
    case "auto": return "gemini-2.5-flash"
  }
}

function serializeTranscript(messages: JagentMessage[]): string {
  const lines = [SYSTEM_PROMPT, "", "Conversation so far:"]
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

async function languageModel(settings: JagentSettings): Promise<{ model: unknown; label: string }> {
  const provider = resolveProvider(settings)
  const modelId = settings.model || defaultModel(provider)

  if (provider === "gemini") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google")
    const google = createGoogleGenerativeAI({ apiKey: settings.apiKeys.gemini })
    return { model: google(modelId), label: `gemini/${modelId}` }
  }

  if (provider === "openai") {
    const { createOpenAI } = await import("@ai-sdk/openai")
    const openai = createOpenAI({ apiKey: settings.apiKeys.openai })
    return { model: openai(modelId), label: `openai/${modelId}` }
  }

  const { createAnthropic } = await import("@ai-sdk/anthropic")
  const anthropic = createAnthropic({ apiKey: settings.apiKeys.anthropic })
  return { model: anthropic(modelId), label: `anthropic/${modelId}` }
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
  const args = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : { input }
  return {
    id: call.toolCallId ?? call.id ?? `tool-${Date.now()}-${index}`,
    name,
    args,
  }
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
  const [{ generateText }, resolved, tools] = await Promise.all([
    import("ai"),
    languageModel(settings),
    jagentTools(),
  ])

  const result = await generateText({
    model: resolved.model as never,
    prompt: serializeTranscript(messages),
    tools: tools as never,
    abortSignal: signal,
  }) as AiSdkGenerateTextResult

  return {
    content: result.text ?? "",
    toolCalls: uniqueToolCalls(result),
    model: result.response?.modelId ?? resolved.label,
  }
}
