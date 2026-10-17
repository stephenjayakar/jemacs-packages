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
  CLAUDE_INSTANCE,
  defaultConfig,
  FALLBACK_CLAUDE_MODEL,
  projectAt,
  settingsModelSelection,
  T3Client,
  type InteractionMode,
  type ModelSelection,
  type RuntimeMode,
  type T3Project,
} from "./client"

/** Kick off Claude Code threads in the T3 Code desktop app from jemacs:
 *  `t3code-compose` asks for the directory the thread runs in, then opens a
 *  prompt buffer whose C-c C-c starts the thread. The thread runs in T3 (it
 *  shows up in the sidebar straight away); jemacs only sends the first prompt. */

export const COMPOSE_MODE = "t3code-prompt-mode"
const COMPOSE_DIRECTORY_LOCAL = "t3code-directory"
const COMPOSE_WINCONF_LOCAL = "t3code-winconf"
export const STATE_FILE = join(homedir(), ".jemacs", "t3code-state.json")

const defaults = defaultConfig()
defcustom("t3code-base-directory", "string", defaults.baseDir, "T3 Code's base directory (holds userdata/server-runtime.json).", "t3code")
defcustom("t3code-app-path", "string", defaults.appPath, "The T3 Code .app bundle, whose bundled CLI issues API tokens.", "t3code")
defcustom("t3code-token", "string", "", "Explicit T3 Code bearer token. Empty: issue one with the app's CLI and cache it in ~/.jemacs/t3code-token.json.", "t3code")
defcustom("t3code-model", "string", "", "Claude model for new threads. Empty: the project's or T3's default Claude model, else claude-opus-5-5.", "t3code")
defcustom("t3code-effort", "string", "", "Reasoning effort for new threads (low, medium, high, xhigh, max, ...). Empty: T3's default.", "t3code")
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

/** Claude selection for a new thread: the project's default, then T3's,
 *  when those are Claude; customs override the model and effort. */
export function resolveModelSelection(
  candidates: Array<ModelSelection | null | undefined>,
  model: string,
  effort: string,
): ModelSelection {
  const base = candidates.find(selection => selection?.instanceId === CLAUDE_INSTANCE)
    ?? { instanceId: CLAUDE_INSTANCE, model: FALLBACK_CLAUDE_MODEL, options: [] }
  let options = base.options ?? []
  // Options like contextWindow are per-model; only effort carries across.
  if (model && model !== base.model) options = options.filter(option => option.id === "effort")
  if (effort) options = [...options.filter(option => option.id !== "effort"), { id: "effort", value: effort }]
  return { instanceId: CLAUDE_INSTANCE, model: model || base.model, options }
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

  async function startThread(prompt: string, dir: string): Promise<void> {
    const target = await projectRootedAt(dir)
    const modelSelection = resolveModelSelection(
      [target.defaultModelSelection, settingsModelSelection(t3().config.baseDir)],
      getCustom<string>("t3code-model") ?? "",
      getCustom<string>("t3code-effort") ?? "",
    )
    editor.message(`t3code: starting thread in ${abbreviateHome(dir)}...`)
    const { title } = await t3().startThread({
      projectId: target.id,
      prompt,
      modelSelection,
      runtimeMode: (getCustom<string>("t3code-runtime-mode") || "full-access") as RuntimeMode,
      interactionMode: (getCustom<string>("t3code-interaction-mode") || "default") as InteractionMode,
    })
    editor.message(`t3code: started "${title}" in ${abbreviateHome(dir)} (${modelSelection.model})`)
    if (getCustom<boolean>("t3code-raise-app")) {
      Bun.spawn(["open", t3().config.appPath], { stdout: "ignore", stderr: "ignore" })
    }
  }

  editor.command("t3code-compose", async () => {
    const initial = readLastDirectory() ?? sourceDirectory(editor)
    const answer = await editor.prompt("Start T3 thread in: ", `${initial.replace(/\/$/, "")}/`, "t3code-directory", { completion: "file" })
    if (!answer?.trim()) return
    const dir = resolve(answer.trim().replace(/^~(?=\/|$)/, homedir()))
    if (!isDirectory(dir)) return editor.message(`t3code: not a directory: ${abbreviateHome(dir)}`)
    writeLastDirectory(dir)

    const name = `*t3code-prompt: ${abbreviateHome(dir)}*`
    const existing = [...editor.buffers.values()].find(buffer => buffer.name === name)
    const winconf = editor.currentWindowConfiguration()
    const buffer = existing ?? editor.addBuffer(new BufferModel({ name, text: "", kind: "scratch", mode: COMPOSE_MODE }))
    if (!existing) editor.enterMode(buffer, COMPOSE_MODE)
    buffer.locals.set("default-directory", dir)
    buffer.locals.set(COMPOSE_DIRECTORY_LOCAL, dir)
    buffer.locals.set(COMPOSE_WINCONF_LOCAL, winconf)
    editor.displayBufferInOtherWindow(buffer.id, { select: true })
    editor.message("Write the prompt; C-c C-c to start the thread, C-c C-k to cancel")
  }, "Pick a directory (default: the last one used), then write a prompt; C-c C-c starts a T3 Code thread there.")

  function closeCompose(buffer: BufferModel): void {
    const winconf = buffer.locals.get(COMPOSE_WINCONF_LOCAL) as ReturnType<Editor["currentWindowConfiguration"]> | undefined
    editor.killBuffer(buffer.id)
    if (winconf) editor.restoreWindowConfiguration(winconf)
  }

  editor.command("t3code-compose-send", async ({ buffer }) => {
    if (buffer.mode !== COMPOSE_MODE) return editor.message("t3code: not in a prompt buffer")
    const prompt = buffer.text
    if (!prompt.trim()) return editor.message("t3code: empty prompt")
    try {
      await startThread(prompt, buffer.locals.get(COMPOSE_DIRECTORY_LOCAL) as string)
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
  defineMode({ name: COMPOSE_MODE, parent: "markdown", keymap: composeMap })

  editor.key("C-c T", "t3code-compose")
}
