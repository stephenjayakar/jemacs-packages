export type JagentBuiltInProviderName = "gemini" | "openai" | "anthropic" | "mock"
export type JagentProviderName = "auto" | JagentBuiltInProviderName | (string & {})

export type JagentProviderKind =
  | JagentBuiltInProviderName
  | "openai-compatible"

export type JagentMockResponse =
  | string
  | {
    content?: string
    toolCalls?: JagentToolCall[]
    model?: string
  }

export type JagentCustomProvider = {
  kind?: JagentProviderKind
  apiKey?: string
  apiKeyEnv?: string
  baseURL?: string
  headers?: Record<string, string>
  defaultModel?: string
  systemPrompt?: string
  modelSystemPrompts?: Record<string, string>
  mockResponses?: JagentMockResponse[]
}

export type JagentSettings = {
  provider: JagentProviderName
  defaultProvider: JagentProviderName
  model: string
  defaultModel: string
  systemPrompt: string
  providerSystemPrompts: Record<string, string>
  modelSystemPrompts: Record<string, string>
  customProviders: Record<string, JagentCustomProvider>
  mockResponses: JagentMockResponse[]
  apiKeys: {
    gemini: string
    openai: string
    anthropic: string
  }
  maxToolRounds: number
  bashTimeoutMs: number
}

export type JagentToolName =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "list_files"
  | "grep"
  | "bash"

export type JagentToolCall = {
  id: string
  name: JagentToolName
  args: Record<string, unknown>
}

export type JagentToolResult = {
  id: string
  name: JagentToolName
  ok: boolean
  output: string
  elapsedMs?: number
}

export type JagentMessage =
  | { role: "user"; content: string; at: string }
  | { role: "assistant"; content: string; at: string; toolCalls?: JagentToolCall[] }
  | { role: "tool"; content: string; at: string; result: JagentToolResult }

export type JagentEvent =
  | { type: "session"; text: string; at: string }
  | { type: "model"; text: string; at: string }
  | { type: "tool_start"; call: JagentToolCall; at: string }
  | { type: "tool_end"; result: JagentToolResult; at: string }
  | { type: "error"; text: string; at: string }

export type JagentCompletion = {
  content: string
  toolCalls: JagentToolCall[]
  model?: string
}
