import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import {
  BufferModel,
  defcustom,
  defineMode,
  getCustom,
  Keymap,
  type Editor,
} from "@jemacs/core"
import {
  AGY_INSTANCE,
  CLAUDE_INSTANCE,
  defaultConfig,
  FALLBACK_AGY_MODEL,
  FALLBACK_CLAUDE_MODEL,
  projectAt,
  settingsModelSelection,
  T3Client,
  type InteractionMode,
  type ModelSelection,
  type RuntimeMode,
  type T3Project,
} from "./client"

/** Kick off Claude Code or Antigravity (agy) threads in the T3 Code desktop app
 *  from jemacs: `t3code-compose` (`C-c T`) or `t3code-compose-agy` (`C-c A`)
 *  asks for the directory the thread runs in, then opens a prompt buffer whose
 *  `C-c C-c` starts the thread in T3 Code's sidebar. */

export const COMPOSE_MODE = "t3code-prompt-mode"
const COMPOSE_DIRECTORY_LOCAL = "t3code-directory"
const COMPOSE_PROVIDER_LOCAL = "t3code-provider"
const COMPOSE_WINCONF_LOCAL = "t3code-winconf"
export const STATE_FILE = join(homedir(), ".jemacs", "t3code-state.json")

const AGY_THINKING_LEVELS = new Set(["low", "medium", "high"])

const defaults = defaultConfig()
defcustom("t3code-base-directory", "string", defaults.baseDir, "T3 Code's base directory (holds userdata/server-runtime.json).", "t3code")
defcustom("t3code-app-path", "string", defaults.appPath, "The T3 Code .app bundle, whose bundled CLI issues API tokens.", "t3code")
defcustom("t3code-token", "string", "", "Explicit T3 Code bearer token. Empty: issue one with the app's CLI and cache it in ~/.jemacs/t3code-token.json.", "t3code")
defcustom("t3code-provider", "string", "", "Default provider for t3code-compose: agy (antigravity) or claude (claudeAgent). Empty: project or T3 default, else claudeAgent.", "t3code")
defcustom("t3code-model", "string", "", "Claude model override for new threads. Empty: the project's or T3's default Claude model, else claude-opus-5-5.", "t3code")
defcustom("t3code-agy-model", "string", "", "Antigravity (agy) model override for new threads. Empty: the project's or T3's default Antigravity model, else gemini-4-carbon.", "t3code")
defcustom("t3code-effort", "string", "", "Reasoning effort / thinking level for new threads (low, medium, high, xhigh, max, ...). Empty: T3's default.", "t3code")
defcustom("t3code-runtime-mode", "string", "full-access", "Runtime mode for new threads: approval-required, auto-accept-edits, auto or full-access.", "t3code")
defcustom("t3code-interaction-mode", "string", "default", "Interaction mode for new threads: default or plan.", "t3code")
defcustom("t3code-raise-app", "boolean", false, "Bring the T3 Code window to the front after starting a thread.", "t3code")

let client: T3Client | null = null
let clientKey = ""

function t3(): T3Client {
  const config = {
    baseDir: getCustom<string>("t3code-base-directory") || defaults.baseDir,
    appPath: getCustom<string>("t3code-app-path") || defaults.appPath,
    tokenFile: defaults.tokenFile,
    token: getCustom<string>("t3code-token") || undefined,
  }
  const key = JSON.stringify(config)
  if (!client || key !== clientKey) {
    client = new T3Client(config)
    clientKey = key
  }
  return client
}

export function normalizeProvider(provider: string): string {
  const trimmed = provider.trim()
  const lower = trimmed.toLowerCase()
  if (!lower) return ""
  if (lower === "agy" || lower === "antigravity") return AGY_INSTANCE
  if (lower === "claude" || lower === "claudeagent" || lower === "claude-code") return CLAUDE_INSTANCE
  return trimmed
}

function providerLabel(instanceId: string): string {
  return instanceId === AGY_INSTANCE ? "agy" : instanceId === CLAUDE_INSTANCE ? "claude" : instanceId
}

function fallbackModelFor(instanceId: string): string {
  return instanceId === AGY_INSTANCE ? FALLBACK_AGY_MODEL : FALLBACK_CLAUDE_MODEL
}

function reasoningOptionId(instanceId: string): string {
  return instanceId === AGY_INSTANCE ? "thought_level" : "effort"
}

function normalizeEffortFor(instanceId: string, effort: string): string {
  const trimmed = effort.trim()
  if (!trimmed || instanceId !== AGY_INSTANCE) return trimmed
  const lower = trimmed.toLowerCase()
  if (AGY_THINKING_LEVELS.has(lower)) return lower
  if (lower === "xhigh" || lower === "max" || lower === "ultracode" || lower === "ultrathink") return "high"
  return trimmed
}

/** Model selection for a new thread: honors an explicit provider (`agy` or
 *  `claude`), else the project's or T3's default when it is Claude or
 *  Antigravity, else Claude; customs override the model and reasoning level. */
export function resolveModelSelection(
  candidates: Array<ModelSelection | null | undefined>,
  model: string,
  effort: string,
  provider = "",
): ModelSelection {
  const explicit = normalizeProvider(provider)
  const supported = new Set([CLAUDE_INSTANCE, AGY_INSTANCE])
  const base = (explicit
    ? candidates.find(selection => selection?.instanceId === explicit)
    : candidates.find(selection => selection && supported.has(selection.instanceId)))
    ?? {
      instanceId: explicit || CLAUDE_INSTANCE,
      model: fallbackModelFor(explicit || CLAUDE_INSTANCE),
      options: [],
    }
  const instanceId = base.instanceId
  const optionKey = reasoningOptionId(instanceId)
  let options = base.options ?? []
  // Options like contextWindow are per-model; only reasoning carries across.
  if (model && model !== base.model) options = options.filter(option => option.id === optionKey)
  const normalizedEffort = normalizeEffortFor(instanceId, effort)
  if (normalizedEffort) {
    options = [...options.filter(option => option.id !== optionKey), { id: optionKey, value: normalizedEffort }]
  }
  return { instanceId, model: model || base.model, options }
}

function abbreviateHome(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

function sourceDirectory(editor: Editor): string {
  const buffer = editor.currentBuffer
  const local = buffer.locals.get("default-directory")
  return resolve(buffer.directory() ?? (typeof local === "string" && local ? local : process.cwd()))
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  }
  catch {
    return false
  }
}

/** The directory the last thread was composed for, if it still exists. */
export function readLastDirectory(file = STATE_FILE): string | null {
  try {
    const dir = JSON.parse(readFileSync(file, "utf8")).lastDirectory
    return typeof dir === "string" && isDirectory(dir) ? dir : null
  }
  catch {
    return null
  }
}

export function writeLastDirectory(dir: string, file = STATE_FILE): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ lastDirectory: dir }, null, 2) + "\n")
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function install(editor: Editor): void {
  /** The T3 project rooted at DIR, adding one when there is none: a thread
   *  runs in its project's root, so this is what makes it start in DIR. */
  async function projectRootedAt(dir: string): Promise<T3Project> {
    const found = projectAt((await t3().snapshot()).projects, dir)
    if (found) return found
    const projectId = await t3().createProject(dir)
    editor.message(`t3code: added project ${abbreviateHome(dir)}`)
    return { id: projectId, title: basename(dir) || dir, workspaceRoot: dir, defaultModelSelection: null, deletedAt: null }
  }

  function modelOverrideFor(instanceId: string): string {
    if (instanceId === AGY_INSTANCE) return getCustom<string>("t3code-agy-model") ?? ""
    return getCustom<string>("t3code-model") ?? ""
  }

  function effectiveProvider(providerOverride = ""): string {
    const explicit = normalizeProvider(providerOverride || (getCustom<string>("t3code-provider") ?? ""))
    if (explicit) return explicit
    const settingsDefault = settingsModelSelection(t3().config.baseDir)?.instanceId
    return settingsDefault === AGY_INSTANCE ? AGY_INSTANCE : CLAUDE_INSTANCE
  }

  async function startThread(prompt: string, dir: string, providerOverride = ""): Promise<void> {
    const target = await projectRootedAt(dir)
    const configuredProvider = normalizeProvider(providerOverride || (getCustom<string>("t3code-provider") ?? ""))
    const provisional = resolveModelSelection(
      [target.defaultModelSelection, settingsModelSelection(t3().config.baseDir)],
      "",
      "",
      configuredProvider,
    )
    const modelSelection = resolveModelSelection(
      [target.defaultModelSelection, settingsModelSelection(t3().config.baseDir)],
      modelOverrideFor(provisional.instanceId),
      getCustom<string>("t3code-effort") ?? "",
      provisional.instanceId,
    )
    const label = providerLabel(modelSelection.instanceId)
    editor.message(`t3code: starting ${label} thread in ${abbreviateHome(dir)}...`)
    const { title } = await t3().startThread({
      projectId: target.id,
      prompt,
      modelSelection,
      runtimeMode: (getCustom<string>("t3code-runtime-mode") || "full-access") as RuntimeMode,
      interactionMode: (getCustom<string>("t3code-interaction-mode") || "default") as InteractionMode,
    })
    editor.message(`t3code: started "${title}" in ${abbreviateHome(dir)} (${label}: ${modelSelection.model})`)
    if (getCustom<boolean>("t3code-raise-app")) {
      Bun.spawn(["open", t3().config.appPath], { stdout: "ignore", stderr: "ignore" })
    }
  }

  function composeBufferName(dir: string, provider: string): string {
    const tag = normalizeProvider(provider) === AGY_INSTANCE ? " [agy]" : ""
    return `*t3code-prompt${tag}: ${abbreviateHome(dir)}*`
  }

  async function openCompose(providerOverride = ""): Promise<void> {
    const initial = readLastDirectory() ?? sourceDirectory(editor)
    const tag = normalizeProvider(providerOverride) === AGY_INSTANCE ? "agy " : ""
    const answer = await editor.prompt(`Start T3 ${tag}thread in: `, `${initial.replace(/\/$/, "")}/`, "t3code-directory", { completion: "file" })
    if (!answer?.trim()) return
    const dir = resolve(answer.trim().replace(/^~(?=\/|$)/, homedir()))
    if (!isDirectory(dir)) {
      editor.message(`t3code: not a directory: ${abbreviateHome(dir)}`)
      return
    }
    writeLastDirectory(dir)

    const name = composeBufferName(dir, providerOverride)
    const existing = [...editor.buffers.values()].find(buffer => buffer.name === name)
    const winconf = editor.currentWindowConfiguration()
    const buffer = existing ?? editor.addBuffer(new BufferModel({ name, text: "", kind: "scratch", mode: COMPOSE_MODE }))
    if (!existing) editor.enterMode(buffer, COMPOSE_MODE)
    buffer.locals.set("default-directory", dir)
    buffer.locals.set(COMPOSE_DIRECTORY_LOCAL, dir)
    buffer.locals.set(COMPOSE_PROVIDER_LOCAL, normalizeProvider(providerOverride))
    buffer.locals.set(COMPOSE_WINCONF_LOCAL, winconf)
    editor.displayBufferInOtherWindow(buffer.id, { select: true })
    const activeLabel = providerLabel(effectiveProvider(providerOverride))
    editor.message(`Write ${activeLabel} prompt; C-c C-c to start, C-c C-p to switch provider, C-c C-k to cancel`)
  }

  editor.command("t3code-compose", async ({ prefixArgument }) => {
    let provider = ""
    if (prefixArgument !== null && prefixArgument !== undefined) {
      const picked = await editor.completingRead("T3 provider: ", { collection: ["agy", "claude"] })
      if (!picked) return
      provider = normalizeProvider(picked)
    }
    await openCompose(provider)
  }, "Pick a directory (default: the last one used), then write a prompt; C-c C-c starts a T3 Code thread there. C-u picks provider (agy or claude).")

  editor.command("t3code-compose-agy", async () => {
    await openCompose(AGY_INSTANCE)
  }, "Pick a directory (default: the last one used), then write a prompt; C-c C-c starts an Antigravity (agy) thread in T3 Code.")

  editor.command("t3code-compose-toggle-provider", ({ buffer }) => {
    if (buffer.mode !== COMPOSE_MODE) return editor.message("t3code: not in a prompt buffer")
    const current = effectiveProvider((buffer.locals.get(COMPOSE_PROVIDER_LOCAL) as string | undefined) ?? "")
    const next = current === AGY_INSTANCE ? CLAUDE_INSTANCE : AGY_INSTANCE
    buffer.locals.set(COMPOSE_PROVIDER_LOCAL, next)
    const dir = buffer.locals.get(COMPOSE_DIRECTORY_LOCAL) as string | undefined
    if (dir) buffer.name = composeBufferName(dir, next)
    const model = next === AGY_INSTANCE
      ? (getCustom<string>("t3code-agy-model") || FALLBACK_AGY_MODEL)
      : (getCustom<string>("t3code-model") || FALLBACK_CLAUDE_MODEL)
    editor.message(`t3code: switched prompt to ${providerLabel(next)} (${model})`)
  }, "Switch this T3 Code prompt buffer between Claude and Antigravity (agy).")

  function closeCompose(buffer: BufferModel): void {
    const winconf = buffer.locals.get(COMPOSE_WINCONF_LOCAL) as ReturnType<Editor["currentWindowConfiguration"]> | undefined
    editor.killBuffer(buffer.id)
    if (winconf) editor.restoreWindowConfiguration(winconf)
  }

  editor.command("t3code-compose-send", async ({ buffer }) => {
    if (buffer.mode !== COMPOSE_MODE) return editor.message("t3code: not in a prompt buffer")
    const prompt = buffer.text
    if (!prompt.trim()) return editor.message("t3code: empty prompt")
    const provider = (buffer.locals.get(COMPOSE_PROVIDER_LOCAL) as string | undefined) ?? ""
    try {
      await startThread(prompt, buffer.locals.get(COMPOSE_DIRECTORY_LOCAL) as string, provider)
    }
    catch (error) {
      // Keep the buffer so the prompt isn't lost.
      return editor.message(`t3code: ${failure(error)}`)
    }
    closeCompose(buffer)
  }, "Start a T3 Code thread with this buffer as the prompt.")

  editor.command("t3code-compose-cancel", ({ buffer }) => {
    if (buffer.mode !== COMPOSE_MODE) return editor.message("t3code: not in a prompt buffer")
    closeCompose(buffer)
    editor.message("t3code: prompt discarded")
  }, "Discard this T3 Code prompt buffer.")

  const composeMap = new Keymap("t3code-prompt-mode-map")
  composeMap.bind("C-c C-c", "t3code-compose-send")
  composeMap.bind("C-c C-k", "t3code-compose-cancel")
  composeMap.bind("C-c C-p", "t3code-compose-toggle-provider")
  defineMode({ name: COMPOSE_MODE, parent: "markdown", keymap: composeMap })

  editor.key("C-c T", "t3code-compose")
  editor.key("C-c A", "t3code-compose-agy")
}
