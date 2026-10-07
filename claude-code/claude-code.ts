import { homedir } from "node:os"
import { basename, join, relative, resolve } from "node:path"
import {
  BufferModel,
  defcustom,
  getCustom,
  listWindowLeaves,
  whichExecutable,
  type Editor,
  type TransientDefinition,
} from "@jemacs/core"
import { jemacsHome } from "../core-path"

/** Port of stevemolitor/claude-code.el: run the local `claude` CLI in a jterm
 *  buffer per project and drive it from source buffers (send region, file and
 *  line context, flymake errors, quick replies, slash commands). */

type JtermSession = {
  alive: boolean
  charMode: boolean
  pty: { pid: number }
  writeRaw(bytes: string): void
  resize(rows: number, cols: number): void
  kill(): void
  dispose(): void
}

type JtermModule = {
  spawnSession: (
    editor: Editor,
    buffer: BufferModel,
    argv: string[],
    opts: { cwd?: string; env?: Record<string, string>; rows: number; cols: number; label: string },
  ) => Promise<JtermSession>
  sessions: WeakMap<BufferModel, JtermSession>
}

const JTERM_MODE = "jterm-mode"
const JTERM_SESSION_LOCAL = "jterm-session"
export const CLAUDE_DIRECTORY_LOCAL = "claude-code-directory"
export const CLAUDE_INSTANCE_LOCAL = "claude-code-instance"

/** Slash commands offered by `claude-code-slash-commands`. Any other input is
 *  sent verbatim, so custom and plugin commands still work. */
export const CLAUDE_SLASH_COMMANDS = [
  "/add-dir", "/agents", "/clear", "/compact", "/config", "/context", "/cost",
  "/doctor", "/exit", "/export", "/help", "/hooks", "/init", "/login", "/logout",
  "/mcp", "/memory", "/model", "/permissions", "/pr-comments", "/resume",
  "/review", "/rewind", "/status", "/terminal-setup", "/todos", "/usage", "/vim",
]

const ESC = "\x1b"
const SHIFT_TAB = "\x1b[Z"

defcustom("claude-code-program", "string", "claude", "Executable name or path of the Claude Code CLI.", "claude-code")
defcustom("claude-code-program-switches", "string", "", "Extra command-line switches passed to the Claude CLI (split on whitespace).", "claude-code")
defcustom("claude-code-submit-delay", "integer", 100, "Milliseconds to wait between sending text and RET, so Claude registers a paste before submitting.", "claude-code")
defcustom("claude-code-startup-timeout", "integer", 15_000, "Milliseconds to wait for a freshly started Claude to draw its prompt before sending to it.", "claude-code")
defcustom("claude-code-toggle-auto-select", "boolean", true, "Select the Claude window when claude-code-toggle shows it.", "claude-code")

let jtermPromise: Promise<JtermModule> | null = null
function loadJterm(): Promise<JtermModule> {
  jtermPromise ??= import(join(jemacsHome(), "plugins/jterm/index.ts")) as Promise<JtermModule>
  return jtermPromise
}

function abbreviateHome(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** `*claude:~/project/*`, or `*claude:~/project/:name*` for extra instances. */
export function claudeBufferName(directory: string, instance = "default"): string {
  const dir = abbreviateHome(resolve(directory)).replace(/\/?$/, "/")
  return instance === "default" ? `*claude:${dir}*` : `*claude:${dir}:${instance}*`
}

export function isClaudeBuffer(buffer: BufferModel): boolean {
  return typeof buffer.locals.get(CLAUDE_DIRECTORY_LOCAL) === "string"
}

export function claudeBuffers(editor: Editor): BufferModel[] {
  return [...editor.buffers.values()].filter(isClaudeBuffer)
}

/** Claude's `@path#Lstart-end` file reference, relative to the session root. */
export function fileReference(path: string, root: string, startLine?: number, endLine?: number): string {
  const rel = relative(root, path)
  const shown = rel && !rel.startsWith("..") ? rel : path
  if (startLine == null) return `@${shown}`
  return endLine != null && endLine !== startLine ? `@${shown}#L${startLine}-${endLine}` : `@${shown}#L${startLine}`
}

/** Bytes that type TEXT into Claude's prompt. Multi-line text is bracketed so
 *  embedded newlines don't submit early. */
export function promptBytes(text: string): string {
  return text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text
}

async function findRoot(dir: string): Promise<string> {
  // Prefer the core project plugin so claude-code agrees with project/magit.
  try {
    const project = await import(join(jemacsHome(), "plugins/project/index.ts")) as {
      projectRoot(dir: string): Promise<string | null>
    }
    return await project.projectRoot(dir) ?? dir
  } catch {
    return dir
  }
}

function sourceDirectory(editor: Editor): string {
  return editor.currentBuffer.directory() ?? process.cwd()
}

function programArgv(extra: string[]): string[] | null {
  const program = getCustom<string>("claude-code-program") || "claude"
  const path = whichExecutable(program) ?? (program.includes("/") ? program : null)
  if (!path) return null
  const switches = (getCustom<string>("claude-code-program-switches") ?? "").split(/\s+/).filter(Boolean)
  return [path, ...switches, ...extra]
}

function sessionOf(jterm: JtermModule, buffer: BufferModel): JtermSession | undefined {
  const session = jterm.sessions.get(buffer)
  return session?.alive ? session : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

/** Wait until a just-started CLI has drawn something and gone quiet, so the
 *  first prompt isn't typed into a half-initialized TUI. */
async function waitForStartup(buffer: BufferModel, session: JtermSession): Promise<void> {
  const deadline = Date.now() + (getCustom<number>("claude-code-startup-timeout") ?? 15_000)
  let last = buffer.text
  let quietSince = Date.now()
  while (session.alive && Date.now() < deadline) {
    await sleep(100)
    if (buffer.text !== last) {
      last = buffer.text
      quietSince = Date.now()
    }
    else if (last.trim() && Date.now() - quietSince >= 500) return
  }
}

function windowShowing(editor: Editor, buffer: BufferModel): string | undefined {
  return listWindowLeaves(editor.windowLayout).find(leaf => leaf.bufferId === buffer.id)?.id
}

/** Display BUFFER in another window (claude-code.el uses display-buffer). */
function showClaude(editor: Editor, buffer: BufferModel, select: boolean): void {
  const windowId = windowShowing(editor, buffer)
  if (windowId) {
    if (select) editor.selectWindow(windowId)
    return
  }
  if (editor.currentBuffer === buffer) return
  editor.displayBufferInOtherWindow(buffer.id, { select })
}

export function install(editor: Editor): void {
  async function start(directory: string, extra: string[], instance = "default", select = true): Promise<BufferModel | null> {
    const argv = programArgv(extra)
    if (!argv) {
      editor.message(`claude-code: cannot find "${getCustom<string>("claude-code-program") || "claude"}" on PATH`)
      return null
    }
    const name = claudeBufferName(directory, instance)
    const existing = [...editor.buffers.values()].find(buffer => buffer.name === name)
    const jterm = await loadJterm()
    if (existing && sessionOf(jterm, existing)) {
      showClaude(editor, existing, select)
      return existing
    }
    if (existing) editor.killBuffer(existing.id)

    const origin = editor.selectedWindowId
    const buffer = editor.addBuffer(new BufferModel({ name, text: "", kind: "scratch", mode: JTERM_MODE }))
    editor.enterMode(buffer, JTERM_MODE)
    buffer.readOnly = true
    buffer.locals.set("default-directory", directory)
    buffer.locals.set(CLAUDE_DIRECTORY_LOCAL, directory)
    buffer.locals.set(CLAUDE_INSTANCE_LOCAL, instance)
    showClaude(editor, buffer, true)

    const rows = (buffer.locals.get("window-body-rows") as number | undefined) ?? 30
    const cols = (buffer.locals.get("window-body-cols") as number | undefined) ?? 100
    const session = await jterm.spawnSession(editor, buffer, argv, {
      cwd: directory,
      rows: Math.max(1, rows),
      cols: Math.max(20, cols),
      label: "claude-code",
    })
    jterm.sessions.set(buffer, session)
    buffer.locals.set(JTERM_SESSION_LOCAL, true)
    // Same first-resize fixup as jterm's own spawn: the configuration-change
    // hook fired before the session was registered.
    const liveRows = buffer.locals.get("window-body-rows") as number | undefined
    const liveCols = buffer.locals.get("window-body-cols") as number | undefined
    if (liveRows && liveCols) session.resize(liveRows, liveCols)
    await editor.run("jterm-char-mode")
    if (!select) editor.selectWindow(origin)
    editor.message(`claude-code: started in ${abbreviateHome(directory)} (pid ${session.pty.pid})`)
    return buffer
  }

  /** The instance commands talk to: the current Claude buffer, else one for
   *  the current project, else the only one; ask when several match. With
   *  START, launch Claude for the project when there is none. */
  async function current(start_ = false): Promise<{ buffer: BufferModel; session: JtermSession } | null> {
    const jterm = await loadJterm()
    const live = claudeBuffers(editor).filter(buffer => sessionOf(jterm, buffer))
    const here = editor.currentBuffer
    let buffer: BufferModel | undefined = live.includes(here) ? here : undefined
    if (!buffer) {
      const root = await findRoot(sourceDirectory(editor))
      const inProject = live.filter(b => b.locals.get(CLAUDE_DIRECTORY_LOCAL) === root)
      const candidates = inProject.length ? inProject : live
      if (candidates.length === 1) buffer = candidates[0]
      else if (candidates.length > 1) buffer = await pick(candidates, "Claude instance: ")
      else if (start_) {
        buffer = await start(root, [], "default", false) ?? undefined
        const session = buffer && sessionOf(jterm, buffer)
        if (session) await waitForStartup(buffer!, session)
      }
    }
    if (!buffer) {
      if (!start_) editor.message("claude-code: no running Claude instance (C-c c c to start one)")
      return null
    }
    const session = sessionOf(jterm, buffer)
    return session ? { buffer, session } : null
  }

  async function pick(buffers: BufferModel[], prompt: string): Promise<BufferModel | undefined> {
    const names = buffers.map(buffer => buffer.name)
    const choice = await editor.completingRead(prompt, { collection: names })
    return buffers.find(buffer => buffer.name === choice)
  }

  async function send(text: string, submit = true): Promise<boolean> {
    const target = await current(true)
    if (!target) return false
    target.session.writeRaw(promptBytes(text))
    if (submit) {
      await sleep(getCustom<number>("claude-code-submit-delay") ?? 100)
      target.session.writeRaw("\r")
    }
    showClaude(editor, target.buffer, false)
    return true
  }

  async function sendRaw(bytes: string, label: string): Promise<void> {
    const target = await current()
    if (!target) return
    target.session.writeRaw(bytes)
    editor.message(`claude-code: sent ${label}`)
  }

  /** `@file#Lx-y` for the current buffer's region or line, relative to the
   *  Claude session root. */
  async function context(): Promise<string | null> {
    const buffer = editor.currentBuffer
    if (!buffer.path || isClaudeBuffer(buffer)) return null
    const root = await findRoot(sourceDirectory(editor))
    if (buffer.markActive && buffer.mark != null && buffer.mark !== buffer.point) {
      const start = Math.min(buffer.mark, buffer.point)
      const end = Math.max(buffer.mark, buffer.point)
      // A region ending at bol doesn't include that line (Emacs region convention).
      const endLine = buffer.lineAt(end) + (end > 0 && buffer.text[end - 1] === "\n" ? 0 : 1)
      return fileReference(buffer.path, root, buffer.lineAt(start) + 1, Math.max(buffer.lineAt(start) + 1, endLine))
    }
    return fileReference(buffer.path, root, buffer.lineAt(buffer.point) + 1)
  }

  // ---- sessions ----

  editor.command("claude-code", async ({ prefixArgument }) => {
    const dir = sourceDirectory(editor)
    const directory = prefixArgument != null
      ? await editor.completingRead("Start Claude in directory: ", { completion: "file", history: "file", initialValue: `${dir}/` })
      : await findRoot(dir)
    if (!directory) return
    await start(resolve(directory), [])
  }, "Start Claude Code in the current project root (C-u: choose the directory).")

  editor.command("claude-code-start-in-directory", async () => {
    const directory = await editor.completingRead("Start Claude in directory: ", {
      completion: "file",
      history: "file",
      initialValue: `${sourceDirectory(editor)}/`,
    })
    if (directory) await start(resolve(directory), [])
  }, "Start Claude Code in a chosen directory.")

  editor.command("claude-code-continue", async () => {
    await start(await findRoot(sourceDirectory(editor)), ["--continue"])
  }, "Start Claude Code continuing the most recent conversation (--continue).")

  editor.command("claude-code-resume", async () => {
    await start(await findRoot(sourceDirectory(editor)), ["--resume"])
  }, "Start Claude Code and pick a past conversation to resume (--resume).")

  editor.command("claude-code-new-instance", async () => {
    const instance = await editor.prompt("Instance name: ", "", "claude-code-instance")
    if (!instance?.trim()) return
    await start(await findRoot(sourceDirectory(editor)), [], instance.trim())
  }, "Start an additional named Claude Code instance for the current project.")

  editor.command("claude-code-kill", async () => {
    const target = await current()
    if (!target) return
    editor.killBuffer(target.buffer.id)
    editor.message(`claude-code: killed ${target.buffer.name}`)
  }, "Kill the current Claude Code instance and its buffer.")

  editor.command("claude-code-kill-all", () => {
    const buffers = claudeBuffers(editor)
    for (const buffer of buffers) editor.killBuffer(buffer.id)
    editor.message(`claude-code: killed ${buffers.length} instance(s)`)
  }, "Kill every Claude Code instance.")

  // ---- windows ----

  editor.command("claude-code-toggle", async () => {
    const target = await current()
    if (!target) return
    const windowId = windowShowing(editor, target.buffer)
    if (windowId && listWindowLeaves(editor.windowLayout).length > 1) {
      const origin = editor.selectedWindowId
      editor.selectWindow(windowId)
      await editor.run("delete-window")
      if (origin !== windowId) editor.selectWindow(origin)
      return
    }
    showClaude(editor, target.buffer, getCustom<boolean>("claude-code-toggle-auto-select") !== false)
  }, "Show or hide the Claude Code window.")

  editor.command("claude-code-switch-to-buffer", async ({ prefixArgument }) => {
    if (prefixArgument != null) return editor.run("claude-code-select-buffer")
    const target = await current()
    if (target) editor.switchToBuffer(target.buffer.id)
  }, "Switch to the current Claude Code buffer (C-u: choose among all instances).")

  editor.command("claude-code-select-buffer", async () => {
    const live = claudeBuffers(editor)
    if (!live.length) return editor.message("claude-code: no running Claude instance")
    const buffer = await pick(live, "Switch to Claude: ")
    if (buffer) editor.switchToBuffer(buffer.id)
  }, "Choose a Claude Code buffer from all running instances.")

  editor.command("claude-code-toggle-read-only-mode", async () => {
    const target = await current()
    if (!target) return
    if (editor.currentBuffer !== target.buffer) editor.switchToBuffer(target.buffer.id)
    await editor.run("jterm-copy-mode")
    editor.message(target.session.charMode
      ? "claude-code: terminal mode"
      : "claude-code: read-only mode (C-c C-t or RET to return)")
  }, "Toggle between typing into Claude and moving/copying through its output.")

  // ---- sending ----

  editor.command("claude-code-send-command", async ({ args }) => {
    const text = args[0] ?? await editor.prompt("Claude: ", "", "claude-code-command")
    if (text) await send(text)
  }, "Read a prompt in the minibuffer and send it to Claude.")

  editor.command("claude-code-send-command-with-context", async ({ args }) => {
    const ref = await context()
    const text = args[0] ?? await editor.prompt(ref ? `Claude (${ref}): ` : "Claude: ", "", "claude-code-command")
    if (!text) return
    await send(ref ? `${text}\n${ref}` : text)
  }, "Send a prompt to Claude with the current file and line (or region lines) as context.")

  editor.command("claude-code-send-region", async ({ prefixArgument }) => {
    const buffer = editor.currentBuffer
    const region = buffer.markActive ? buffer.selectedText() : ""
    const text = region || buffer.text
    if (!text.trim()) return editor.message("claude-code: nothing to send")
    if (prefixArgument != null) {
      const instruction = await editor.prompt("Instruction: ", "", "claude-code-command")
      if (instruction == null) return
      await send(instruction ? `${instruction}\n\n${text}` : text)
    }
    else await send(text)
    buffer.markActive = false
  }, "Send the region (or the whole buffer) to Claude (C-u: prefix an instruction).")

  editor.command("claude-code-send-buffer-file", async ({ prefixArgument }) => {
    const buffer = editor.currentBuffer
    if (!buffer.path) return editor.message("claude-code: buffer is not visiting a file")
    const ref = fileReference(buffer.path, await findRoot(sourceDirectory(editor)))
    if (prefixArgument != null) {
      const instruction = await editor.prompt(`Claude (${ref}): `, "", "claude-code-command")
      if (instruction == null) return
      await send(instruction ? `${instruction} ${ref}` : ref)
    }
    else await send(ref, false)
  }, "Insert an @reference to the current file into Claude's prompt (C-u: add an instruction and submit).")

  editor.command("claude-code-fix-error-at-point", async () => {
    const buffer = editor.currentBuffer
    const line = buffer.lineAt(buffer.point)
    const diags = buffer.path && editor.lsp
      ? editor.lsp.bufferWorkspaces(buffer).flatMap(ws => ws.diagnosticsByPath.get(buffer.path!) ?? [])
      : []
    const here = diags.filter(d => d.range.start.line <= line && line <= d.range.end.line)
    if (!here.length) return editor.message("claude-code: no error at point")
    const ref = await context()
    const messages = here.map(d => `- ${d.source ? `${d.source}: ` : ""}${d.message}`).join("\n")
    await send(`Fix this error${here.length > 1 ? "s" : ""} at ${ref ?? basename(buffer.path ?? buffer.name)}:\n${messages}`)
  }, "Ask Claude to fix the flymake/LSP diagnostics on the current line.")

  editor.command("claude-code-slash-commands", async () => {
    const choice = await editor.completingRead("Slash command: ", { collection: CLAUDE_SLASH_COMMANDS, initialValue: "/" })
    if (choice?.trim()) await send(choice.trim())
  }, "Pick a Claude slash command and send it.")

  // ---- quick replies ----

  editor.command("claude-code-send-return", () => sendRaw("\r", "RET"), "Send RET to Claude (accept / submit).")
  editor.command("claude-code-send-escape", () => sendRaw(ESC, "ESC"), "Send ESC to Claude (reject / interrupt).")
  editor.command("claude-code-cycle-mode", () => sendRaw(SHIFT_TAB, "S-TAB"), "Cycle Claude's mode: default, auto-accept edits, plan (S-TAB).")
  editor.command("claude-code-fork", () => sendRaw(ESC + ESC, "ESC ESC"), "Jump back to a previous message to fork the conversation (ESC ESC).")
  for (const n of ["1", "2", "3"]) {
    editor.command(`claude-code-send-${n}`, () => sendRaw(n, n), `Send "${n}" to Claude to choose option ${n}.`)
  }

  editor.command("claude-code-transient", () => {
    editor.openTransient(claudeCodeMenu)
  }, "Show the Claude Code command menu.")

  // ---- keys: claude-code.el's suggested C-c c prefix ----

  const keys: Array<[string, string]> = [
    ["c", "claude-code"],
    ["d", "claude-code-start-in-directory"],
    ["C", "claude-code-continue"],
    ["R", "claude-code-resume"],
    ["i", "claude-code-new-instance"],
    ["k", "claude-code-kill"],
    ["K", "claude-code-kill-all"],
    ["t", "claude-code-toggle"],
    ["b", "claude-code-switch-to-buffer"],
    ["B", "claude-code-select-buffer"],
    ["z", "claude-code-toggle-read-only-mode"],
    ["s", "claude-code-send-command"],
    ["x", "claude-code-send-command-with-context"],
    ["r", "claude-code-send-region"],
    ["o", "claude-code-send-buffer-file"],
    ["e", "claude-code-fix-error-at-point"],
    ["/", "claude-code-slash-commands"],
    ["y", "claude-code-send-return"],
    ["n", "claude-code-send-escape"],
    ["f", "claude-code-fork"],
    ["M", "claude-code-cycle-mode"],
    ["1", "claude-code-send-1"],
    ["2", "claude-code-send-2"],
    ["3", "claude-code-send-3"],
    ["m", "claude-code-transient"],
  ]
  for (const [key, command] of keys) editor.key(`C-c c ${key}`, command)
}

const claudeCodeMenu: TransientDefinition = {
  name: "claude-code-transient",
  title: "Claude Code",
  groups: [
    {
      title: "Start / stop",
      suffixes: [
        { key: "c", label: "Start Claude", command: "claude-code" },
        { key: "d", label: "Start in directory", command: "claude-code-start-in-directory" },
        { key: "C", label: "Continue conversation", command: "claude-code-continue" },
        { key: "R", label: "Resume conversation", command: "claude-code-resume" },
        { key: "i", label: "New instance", command: "claude-code-new-instance" },
        { key: "k", label: "Kill", command: "claude-code-kill" },
        { key: "K", label: "Kill all", command: "claude-code-kill-all" },
      ],
    },
    {
      title: "Send",
      suffixes: [
        { key: "s", label: "Send command", command: "claude-code-send-command" },
        { key: "x", label: "Send with file context", command: "claude-code-send-command-with-context" },
        { key: "r", label: "Send region / buffer", command: "claude-code-send-region" },
        { key: "o", label: "Send file reference", command: "claude-code-send-buffer-file" },
        { key: "e", label: "Fix error at point", command: "claude-code-fix-error-at-point" },
        { key: "/", label: "Slash command", command: "claude-code-slash-commands" },
      ],
    },
    {
      title: "Respond / window",
      suffixes: [
        { key: "y", label: "Return (yes)", command: "claude-code-send-return" },
        { key: "n", label: "Escape (no)", command: "claude-code-send-escape" },
        { key: "1", label: "Option 1", command: "claude-code-send-1" },
        { key: "2", label: "Option 2", command: "claude-code-send-2" },
        { key: "3", label: "Option 3", command: "claude-code-send-3" },
        { key: "M", label: "Cycle mode", command: "claude-code-cycle-mode" },
        { key: "f", label: "Fork conversation", command: "claude-code-fork" },
        { key: "t", label: "Toggle window", command: "claude-code-toggle" },
        { key: "b", label: "Switch to buffer", command: "claude-code-switch-to-buffer" },
        { key: "z", label: "Read-only mode", command: "claude-code-toggle-read-only-mode" },
      ],
    },
  ],
}
