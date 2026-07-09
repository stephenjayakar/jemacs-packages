import type { SpawnHandle } from "@jemacs/core"
import type { GeminiJsonResponse } from "./types"

export type RunGeminiOptions = {
  prompt: string
  stdin?: string
  cwd: string
  model?: string
  yolo?: boolean
  geminiPath: string
  spawn: (options: {
    cmd: string[]
    cwd?: string
    stdin?: "pipe" | "ignore"
    stdout?: "pipe" | "ignore"
    stderr?: "pipe" | "ignore"
  }) => SpawnHandle
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  return new Response(stream).text()
}

export async function runGeminiJson(options: RunGeminiOptions): Promise<GeminiJsonResponse> {
  const cmd = [
    options.geminiPath,
    "-p",
    options.prompt,
    "--output-format",
    "json",
  ]
  if (options.model) cmd.push("-m", options.model)
  if (options.yolo) cmd.push("-y")

  const proc = options.spawn({
    cmd,
    cwd: options.cwd,
    stdin: options.stdin != null ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  if (options.stdin != null && proc.stdin) {
    proc.stdin.write(options.stdin)
    proc.stdin.end()
  }

  const [stdout, stderr, code] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited,
  ])

  const trimmed = stdout.trim()
  if (!trimmed) {
    throw new Error(stderr.trim() || `gemini exited with code ${code ?? "?"}`)
  }

  let json: GeminiJsonResponse
  try {
    json = JSON.parse(trimmed) as GeminiJsonResponse
  } catch {
    throw new Error(stderr.trim() || "gemini returned invalid JSON")
  }

  if (json.error && !json.response) {
    return json
  }
  if (code != null && code !== 0 && !json.response) {
    json.error ??= { type: "ExitError", message: stderr.trim() || `exit ${code}` }
  }
  return json
}
