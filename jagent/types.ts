export type JagentProviderName = "auto" | "gemini" | "openai" | "anthropic"

export type JagentSettings = {
  provider: JagentProviderName
  model: string
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
