import { homedir } from "node:os"
import { resolve } from "node:path"
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
  projectFor,
  settingsModelSelection,
  T3Client,
  workspaceRootFor,
  type InteractionMode,
  type ModelSelection,
  type RuntimeMode,
  type T3Project,
} from "./client"

/** Kick off Claude Code threads in the T3 Code desktop app from jemacs. The
 *  thread runs in T3 (it shows up in the sidebar straight away); jemacs only
 *  sends the first prompt. */

export const COMPOSE_MODE = "t3code-prompt-mode"
const COMPOSE_DIRECTORY_LOCAL = "t3code-directory"
const COMPOSE_PROJECT_LOCAL = "t3code-project"
const COMPOSE_WINCONF_LOCAL = "t3code-winconf"

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
  const composed = buffer.locals.get(COMPOSE_DIRECTORY_LOCAL)
  if (typeof composed === "string") return composed
  const local = buffer.locals.get("default-directory")
  return resolve(buffer.directory() ?? (typeof local === "string" && local ? local : process.cwd()))
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function install(editor: Editor): void {
  /** The project for DIR: the T3 project covering it, else offer to add its
   *  repository root. With CHOOSE, pick from every project instead. */
  async function project(dir: string, choose: boolean): Promise<T3Project | null> {
    const projects = (await t3().snapshot()).projects.filter(project => !project.deletedAt)
    if (choose) {
      const label = (project: T3Project) => `${project.title} (${abbreviateHome(project.workspaceRoot)})`
      const choice = await editor.completingRead("T3 project: ", { collection: projects.map(label) })
      return projects.find(project => label(project) === choice) ?? null
    }
    const found = projectFor(projects, dir)
    if (found) return found
    const root = await editor.prompt(
      `No T3 project contains ${abbreviateHome(dir)}; add project at: `,
      `${workspaceRootFor(dir)}/`,
      "file",
      { completion: "file" },
    )
    if (!root?.trim()) return null
    const workspaceRoot = resolve(root.trim())
    const projectId = await t3().createProject(workspaceRoot)
    editor.message(`t3code: added project ${abbreviateHome(workspaceRoot)}`)
    return { id: projectId, title: workspaceRoot, workspaceRoot, defaultModelSelection: null, deletedAt: null }
  }

  async function startThread(prompt: string, target: T3Project): Promise<boolean> {
    const modelSelection = resolveModelSelection(
      [target.defaultModelSelection, settingsModelSelection(t3().config.baseDir)],
      getCustom<string>("t3code-model") ?? "",
      getCustom<string>("t3code-effort") ?? "",
    )
    editor.message(`t3code: starting thread in ${target.title}...`)
    const { title } = await t3().startThread({
      projectId: target.id,
      prompt,
      modelSelection,
      runtimeMode: (getCustom<string>("t3code-runtime-mode") || "full-access") as RuntimeMode,
      interactionMode: (getCustom<string>("t3code-interaction-mode") || "default") as InteractionMode,
    })
    editor.message(`t3code: started "${title}" in ${target.title} (${modelSelection.model})`)
    if (getCustom<boolean>("t3code-raise-app")) {
      Bun.spawn(["open", t3().config.appPath], { stdout: "ignore", stderr: "ignore" })
    }
    return true
  }

  /** Resolve the project for the current buffer, then send PROMPT. Errors are
   *  reported in the echo area rather than thrown into the command loop. */
  async function send(prompt: string, choose: boolean, dir = sourceDirectory(editor)): Promise<boolean> {
    if (!prompt.trim()) {
      editor.message("t3code: empty prompt")
      return false
    }
    try {
      const target = await project(dir, choose)
      return target ? await startThread(prompt, target) : false
    }
    catch (error) {
      editor.message(`t3code: ${failure(error)}`)
      return false
    }
  }

  editor.command("t3code-new-thread", async ({ args, prefixArgument }) => {
    const prompt = args[0] ?? await editor.prompt("T3 Claude: ", "", "t3code-prompt")
    if (prompt != null) await send(prompt, prefixArgument != null)
  }, "Start a Claude Code thread in T3 Code with a prompt from the minibuffer (C-u: choose the project).")

  editor.command("t3code-new-thread-from-region", async ({ prefixArgument }) => {
    const buffer = editor.currentBuffer
    const region = buffer.markActive ? buffer.selectedText() : ""
    const text = region || buffer.text
    if (!text.trim()) return editor.message("t3code: nothing to send")
    const instruction = prefixArgument != null ? await editor.prompt("Instruction: ", "", "t3code-prompt") : ""
    if (instruction == null) return
    const where = buffer.path ? `From ${abbreviateHome(buffer.path)}:\n\n` : ""
    if (await send(instruction ? `${instruction}\n\n${where}${text}` : text, false)) buffer.markActive = false
  }, "Start a T3 Code thread with the region (or whole buffer) as the prompt (C-u: prefix an instruction).")

  editor.command("t3code-compose", async ({ prefixArgument }) => {
    const dir = sourceDirectory(editor)
    let chosen: T3Project | null = null
    if (prefixArgument != null) {
      try {
        chosen = await project(dir, true)
      }
      catch (error) {
        return editor.message(`t3code: ${failure(error)}`)
      }
      if (!chosen) return
    }
    const name = `*t3code-prompt: ${abbreviateHome(chosen?.workspaceRoot ?? dir)}*`
    const existing = [...editor.buffers.values()].find(buffer => buffer.name === name)
    const winconf = editor.currentWindowConfiguration()
    const buffer = existing ?? editor.addBuffer(new BufferModel({ name, text: "", kind: "scratch", mode: COMPOSE_MODE }))
    if (!existing) editor.enterMode(buffer, COMPOSE_MODE)
    buffer.locals.set("default-directory", chosen?.workspaceRoot ?? dir)
    buffer.locals.set(COMPOSE_DIRECTORY_LOCAL, chosen?.workspaceRoot ?? dir)
    buffer.locals.set(COMPOSE_PROJECT_LOCAL, chosen)
    buffer.locals.set(COMPOSE_WINCONF_LOCAL, winconf)
    editor.displayBufferInOtherWindow(buffer.id, { select: true })
    editor.message("Write the prompt; C-c C-c to start the thread, C-c C-k to cancel")
  }, "Write a multi-line prompt in a buffer, then C-c C-c starts a T3 Code thread (C-u: choose the project).")

  function closeCompose(buffer: BufferModel): void {
    const winconf = buffer.locals.get(COMPOSE_WINCONF_LOCAL) as ReturnType<Editor["currentWindowConfiguration"]> | undefined
    editor.killBuffer(buffer.id)
    if (winconf) editor.restoreWindowConfiguration(winconf)
  }

  editor.command("t3code-compose-send", async ({ buffer }) => {
    if (buffer.mode !== COMPOSE_MODE) return editor.message("t3code: not in a prompt buffer")
    const dir = buffer.locals.get(COMPOSE_DIRECTORY_LOCAL) as string
    const chosen = buffer.locals.get(COMPOSE_PROJECT_LOCAL) as T3Project | null
    const prompt = buffer.text
    if (!prompt.trim()) return editor.message("t3code: empty prompt")
    try {
      const target = chosen ?? await project(dir, false)
      if (!target || !await startThread(prompt, target)) return
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

  editor.command("t3code-open-app", () => {
    Bun.spawn(["open", t3().config.appPath], { stdout: "ignore", stderr: "ignore" })
  }, "Bring the T3 Code window to the front.")

  const composeMap = new Keymap("t3code-prompt-mode-map")
  composeMap.bind("C-c C-c", "t3code-compose-send")
  composeMap.bind("C-c C-k", "t3code-compose-cancel")
  defineMode({ name: COMPOSE_MODE, parent: "markdown", keymap: composeMap })

  const keys: Array<[string, string]> = [
    ["n", "t3code-new-thread"],
    ["c", "t3code-compose"],
    ["r", "t3code-new-thread-from-region"],
    ["o", "t3code-open-app"],
  ]
  for (const [key, command] of keys) editor.key(`C-c T ${key}`, command)
}
