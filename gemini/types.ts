export type GeminiJsonError = {
  type?: string
  message?: string
  code?: number
}

export type GeminiTokenStats = {
  input?: number
  prompt?: number
  candidates?: number
  total?: number
  cached?: number
  thoughts?: number
  tool?: number
}

export type GeminiModelStats = {
  api?: {
    totalRequests?: number
    totalErrors?: number
    totalLatencyMs?: number
  }
  tokens?: GeminiTokenStats
}

export type GeminiJsonResponse = {
  session_id?: string
  response?: string | null
  stats?: {
    models?: Record<string, GeminiModelStats>
    tools?: {
      totalCalls?: number
      totalSuccess?: number
      totalFail?: number
      totalDurationMs?: number
    }
    files?: {
      totalLinesAdded?: number
      totalLinesRemoved?: number
    }
  }
  error?: GeminiJsonError | null
}

export type GeminiTurn = {
  role: "user" | "assistant"
  prompt?: string
  response?: string
  error?: GeminiJsonError
  sessionId?: string
  model?: string
  latencyMs?: number
  tokens?: GeminiTokenStats
  toolCalls?: number
  at: string
}
