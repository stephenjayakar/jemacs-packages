import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

/** Minimal client for a locally running T3 Code server: discovery from
 *  `<base>/userdata/server-runtime.json`, a bearer token minted with the app's
 *  bundled CLI (`auth session issue`), and the HTTP orchestration API. */

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

export type T3Snapshot = { snapshotSequence: number; projects: T3Project[] }

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
export const FALLBACK_CLAUDE_MODEL = "claude-opus-5-5"
const TITLE_MAX = 50

export function defaultConfig(): T3Config {
  return {
    baseDir: join(homedir(), ".t3"),
    appPath: "/Applications/T3 Code (Alpha).app",
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

/** The `thread.create` + `thread.turn.start` pair the web client sends for a
 *  first message. The server regenerates the title from `titleSeed`. */
export function newThreadCommands(input: NewThread, now = new Date(), id: () => string = randomUUID) {
  const threadId = id()
  const createdAt = now.toISOString()
  const title = threadTitle(input.prompt)
  const create = {
    type: "thread.create",
    commandId: id(),
    threadId,
    projectId: input.projectId,
    title,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    branch: null,
    worktreePath: null,
    createdAt,
  }
  const turn = {
    type: "thread.turn.start",
    commandId: id(),
    threadId,
    message: { messageId: id(), role: "user", text: input.prompt, attachments: [] },
    modelSelection: input.modelSelection,
    titleSeed: title,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    createdAt,
  }
  return { threadId, title, create, turn }
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
    return await this.request<T3Snapshot>("GET", "/api/orchestration/snapshot")
  }

  async dispatch(command: object): Promise<{ sequence: number }> {
    return await this.request<{ sequence: number }>("POST", "/api/orchestration/dispatch", command)
  }

  async createProject(workspaceRoot: string): Promise<string> {
    const projectId = randomUUID()
    await this.dispatch({
      type: "project.create",
      commandId: randomUUID(),
      projectId,
      title: basename(workspaceRoot) || workspaceRoot,
      workspaceRoot,
      createWorkspaceRootIfMissing: false,
      createdAt: new Date().toISOString(),
    })
    return projectId
  }

  async startThread(input: NewThread): Promise<{ threadId: string; title: string }> {
    const { threadId, title, create, turn } = newThreadCommands(input)
    await this.dispatch(create)
    await this.dispatch(turn)
    return { threadId, title }
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
    return [error.code ?? error._tag, error.reason].filter(Boolean).join(": ") || text
  }
  catch {
    return text || "(empty response)"
  }
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
