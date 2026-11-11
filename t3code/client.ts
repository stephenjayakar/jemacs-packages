import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

/** Minimal client for a locally running T3 Code server: discovery from
 *  `<base>/userdata/server-runtime.json`, a bearer token minted with the app's
 *  bundled CLI (`auth session issue`), REST `/api/projects`, and the v2
 *  WebSocket RPC (`orchestration.launchThread`). */

export type ModelOption = { id: string; value: string | boolean | number }
export type ModelSelection = { instanceId: string; model: string; options?: ModelOption[] }
export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access"
export type InteractionMode = "default" | "plan"

export type T3Project = {
  id: string
  title: string
  workspaceRoot: string
  defaultModelSelection: ModelSelection | null
  deletedAt: string | null
}

export type T3Snapshot = { projects: T3Project[]; updatedAt?: string }

export type T3Config = {
  /** T3 base directory (`~/.t3`), holding `userdata/`. */
  baseDir: string
  /** The T3 Code `.app` bundle whose CLI mints tokens. */
  appPath: string
  /** Where the minted token is cached between sessions. */
  tokenFile: string
  /** Explicit token; skips minting and the cache when set. */
  token?: string
}

type CachedToken = { sessionId: string; token: string; expiresAt: string }

export const CLAUDE_INSTANCE = "claudeAgent"
export const AGY_INSTANCE = "antigravity"
export const FALLBACK_CLAUDE_MODEL = "claude-opus-5-5"
export const FALLBACK_AGY_MODEL = "gemini-4-carbon"
const TITLE_MAX = 50

const APP_CANDIDATES = [
  "/Applications/T3 Code (Beta).app",
  "/Applications/T3 Code.app",
  "/Applications/T3 Code (Alpha).app",
]

export function defaultAppPath(): string {
  return APP_CANDIDATES.find(path => existsSync(path)) ?? APP_CANDIDATES[0]!
}

export function defaultConfig(): T3Config {
  return {
    baseDir: join(homedir(), ".t3"),
    appPath: defaultAppPath(),
    tokenFile: join(homedir(), ".jemacs", "t3code-token.json"),
  }
}

/** The server's origin (e.g. `http://127.0.0.1:3773`), or null when T3 Code
 *  isn't running. */
export function serverOrigin(baseDir: string): string | null {
  try {
    const runtime = JSON.parse(readFileSync(join(baseDir, "userdata", "server-runtime.json"), "utf8"))
    return typeof runtime.origin === "string" ? runtime.origin : null
  }
  catch {
    return null
  }
}

/** T3's own default model selection from its settings, if any. */
export function settingsModelSelection(baseDir: string): ModelSelection | null {
  try {
    const settings = JSON.parse(readFileSync(join(baseDir, "userdata", "settings.json"), "utf8"))
    const selection = settings.defaultModelSelection
    return selection && typeof selection.model === "string" ? selection : null
  }
  catch {
    return null
  }
}

/** The web client's title rule: trimmed, cut at 50 chars with `...`. */
export function threadTitle(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, " ")
  if (!trimmed) return "New thread"
  return trimmed.length <= TITLE_MAX ? trimmed : `${trimmed.slice(0, TITLE_MAX)}...`
}

/** The live project whose workspace root is exactly DIR. */
export function projectAt(projects: T3Project[], dir: string): T3Project | undefined {
  const target = resolve(dir)
  return projects.find(project => !project.deletedAt && resolve(project.workspaceRoot) === target)
}

export type NewThread = {
  projectId: string
  prompt: string
  modelSelection: ModelSelection
  runtimeMode: RuntimeMode
  interactionMode: InteractionMode
}

/** The `orchestration.launchThread` RPC payload for starting a new thread with
 *  its first user message. `generateTitle: true` asks T3 to refine `title`. */
export function newThreadCommands(input: NewThread, id: () => string = randomUUID) {
  const threadId = id()
  const title = threadTitle(input.prompt)
  const runtimeMode: RuntimeMode = input.modelSelection.instanceId === AGY_INSTANCE && input.runtimeMode === "auto"
    ? "auto-accept-edits"
    : input.runtimeMode
  const launch = {
    commandId: id(),
    threadId,
    projectId: input.projectId,
    title,
    generateTitle: true,
    modelSelection: input.modelSelection,
    runtimeMode,
    interactionMode: input.interactionMode,
    workspaceStrategy: { type: "root" as const },
    initialMessage: {
      messageId: id(),
      text: input.prompt,
      attachments: [] as never[],
    },
  }
  return { threadId, title, launch }
}

export class T3Error extends Error {}

export class T3Client {
  private token: string | null = null

  constructor(readonly config: T3Config) {}

  origin(): string {
    const origin = serverOrigin(this.config.baseDir)
    if (!origin) throw new T3Error(`T3 Code isn't running (no ${join(this.config.baseDir, "userdata", "server-runtime.json")})`)
    return origin
  }

  async snapshot(): Promise<T3Snapshot> {
    return await this.request<T3Snapshot>("GET", "/api/projects")
  }

  async createProject(workspaceRoot: string): Promise<string> {
    const projectId = randomUUID()
    const created = await this.request<T3Project>("POST", "/api/projects/mutate", {
      type: "project.create",
      commandId: randomUUID(),
      projectId,
      title: basename(workspaceRoot) || workspaceRoot,
      workspaceRoot,
      createWorkspaceRootIfMissing: false,
    })
    return created.id || projectId
  }

  async startThread(input: NewThread): Promise<{ threadId: string; title: string }> {
    const { threadId, title, launch } = newThreadCommands(input)
    const launched = await this.rpc<{ threadId: string }>("orchestration.launchThread", launch)
    return { threadId: launched.threadId || threadId, title }
  }

  /** One v2 WebSocket RPC call using a short-lived `wsTicket`. */
  async rpc<T>(tag: string, payload: object): Promise<T> {
    const { ticket } = await this.request<{ ticket: string }>("POST", "/api/auth/websocket-ticket/rpc")
    const wsUrl = `${this.origin().replace(/^http/, "ws")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`
    return await new Promise<T>((resolveRpc, rejectRpc) => {
      const ws = new WebSocket(wsUrl)
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        try { ws.close() } catch {}
        fn()
      }
      ws.onopen = () => {
        ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }))
      }
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data))
          if (msg._tag !== "Exit" || (msg.requestId && msg.requestId !== "1")) return
          if (msg.exit?._tag === "Success") finish(() => resolveRpc(msg.exit.value as T))
          else finish(() => rejectRpc(new T3Error(`${tag}: ${rpcErrorDetail(msg.exit)}`)))
        }
        catch (error) {
          finish(() => rejectRpc(error instanceof Error ? error : new T3Error(String(error))))
        }
      }
      ws.onerror = () => {
        finish(() => rejectRpc(new T3Error(`${tag}: WebSocket connection to T3 Code failed`)))
      }
      ws.onclose = () => {
        finish(() => rejectRpc(new T3Error(`${tag}: T3 Code closed the connection before replying`)))
      }
    })
  }

  /** One request, re-minting the token once if the server rejects it. */
  private async request<T>(method: string, path: string, body?: object): Promise<T> {
    const url = this.origin() + path
    const send = async (token: string) => await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    let response = await send(await this.bearer())
    if (response.status === 401 && !this.config.token) {
      response = await send(await this.bearer(true))
    }
    const text = await response.text()
    if (!response.ok) throw new T3Error(`${method} ${path}: ${response.status} ${errorDetail(text)}`)
    return (text ? JSON.parse(text) : {}) as T
  }

  private async bearer(refresh = false): Promise<string> {
    if (this.config.token) return this.config.token
    if (!refresh && this.token) return this.token
    if (!refresh) {
      const cached = readCachedToken(this.config.tokenFile)
      if (cached) return this.token = cached.token
    }
    const issued = await issueToken(this.config)
    writeCachedToken(this.config.tokenFile, issued)
    return this.token = issued.token
  }
}

function errorDetail(text: string): string {
  try {
    const error = JSON.parse(text)
    return [error.code ?? error._tag, error.reason ?? error.message].filter(Boolean).join(": ") || text
  }
  catch {
    return text || "(empty response)"
  }
}

function rpcErrorDetail(exit: any): string {
  const causes = Array.isArray(exit?.cause) ? exit.cause : []
  const error = causes.find((entry: any) => entry?.error)?.error
  if (error && typeof error === "object") {
    return error.detail || error.message || error._tag || JSON.stringify(error)
  }
  return exit ? JSON.stringify(exit) : "unknown RPC failure"
}

function readCachedToken(file: string): CachedToken | null {
  try {
    const cached = JSON.parse(readFileSync(file, "utf8")) as CachedToken
    // Re-mint a day early rather than fail mid-request.
    return cached.token && Date.parse(cached.expiresAt) - Date.now() > 86_400_000 ? cached : null
  }
  catch {
    return null
  }
}

function writeCachedToken(file: string, token: CachedToken): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(token, null, 2) + "\n", { mode: 0o600 })
  chmodSync(file, 0o600)
}

/** Mint a bearer session with the app's bundled server CLI, run under the
 *  app's Electron binary as plain Node. It writes straight to T3's state
 *  database, so the running server accepts the token immediately. */
export async function issueToken(config: T3Config): Promise<CachedToken> {
  const executable = join(config.appPath, "Contents", "MacOS", basename(config.appPath, ".app"))
  const cli = join(config.appPath, "Contents", "Resources", "app.asar", "apps", "server", "dist", "bin.mjs")
  if (!existsSync(executable)) throw new T3Error(`T3 Code app not found at ${config.appPath}`)
  const args = [cli, "auth", "session", "issue", "--base-dir", config.baseDir, "--label", "jemacs", "--ttl", "30d", "--json"]
  const { code, stdout, stderr } = await run(executable, args, { ...process.env, ELECTRON_RUN_AS_NODE: "1" })
  if (code !== 0) throw new T3Error(`issuing a T3 Code token failed: ${(stderr || stdout).trim()}`)
  const issued = JSON.parse(stdout.slice(stdout.indexOf("{")))
  if (typeof issued.token !== "string") throw new T3Error("issuing a T3 Code token failed: no token in output")
  return { sessionId: issued.sessionId, token: issued.token, expiresAt: issued.expiresAt }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", chunk => stdout += chunk)
    child.stderr.on("data", chunk => stderr += chunk)
    child.on("error", reject)
    child.on("close", code => resolveRun({ code: code ?? 1, stdout, stderr }))
  })
}
