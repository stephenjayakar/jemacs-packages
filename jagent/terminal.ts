import { homedir } from "node:os"
import { join } from "node:path"
import type { BufferModel, Editor } from "@jemacs/core"

type JtermModule = {
  spawnSession: (
    editor: Editor,
    buffer: BufferModel,
    argv: string[],
    opts: { cwd?: string; env?: Record<string, string>; rows: number; cols: number; label: string },
  ) => Promise<JtermSession>
  sessions: WeakMap<BufferModel, JtermSession>
}

type JtermSession = {
  alive: boolean
  exitCode: number | null
  pty: { pid: number }
  resize(rows: number, cols: number): void
  kill(): void
  dispose(): void
}

export type JagentTerminalRun = {
  buffer: BufferModel
  command: string
  output: string
  exitCode: number | null
  timedOut: boolean
  elapsedMs: number
}

const JAGENT_TERMINAL_BUFFER = "*Jagent Terminal*"
const JTERM_SESSION_LOCAL = "jterm-session"

function jemacsHome(): string {
  return process.env.JEMACS_HOME ?? join(homedir(), "programming", "jemacs", "jemacs-opentui")
}

async function loadJterm(): Promise<JtermModule> {
  return await import(join(jemacsHome(), "plugins/jterm/index.ts")) as JtermModule
}

function bodyDims(buffer: BufferModel): { rows: number; cols: number } {
  const rows = (buffer.locals.get("window-body-rows") as number | undefined) ?? 30
  const cols = (buffer.locals.get("window-body-cols") as number | undefined) ?? 100
  return { rows: Math.max(1, rows), cols: Math.max(20, cols) }
}

function terminalBuffer(editor: Editor): BufferModel | undefined {
  return [...editor.buffers.values()].find(buffer => buffer.name === JAGENT_TERMINAL_BUFFER)
}

function shellCommand(command: string): string[] {
  const shell = process.env.SHELL ?? "bash"
  return [shell, "-lc", `printf '$ %s\\n' ${shellQuote(command)}; ${command}`]
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function trimTerminalOutput(text: string): string {
  return text
    .replace(/\n\[process exited [^\]]+\]\n?$/m, "")
    .trimEnd()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function ensureJagentTerminal(editor: Editor, cwd: string): Promise<BufferModel> {
  let buffer = terminalBuffer(editor)
  if (!buffer) buffer = editor.scratch(JAGENT_TERMINAL_BUFFER, "", "jterm-mode")
  else editor.enterMode(buffer, "jterm-mode")
  buffer.locals.set("default-directory", cwd)
  return buffer
}

export async function runCommandInJterm(
  editor: Editor,
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<JagentTerminalRun> {
  const jterm = await loadJterm()
  const buffer = await ensureJagentTerminal(editor, cwd)
  const existing = jterm.sessions.get(buffer)
  existing?.dispose()

  buffer.readOnly = false
  buffer.setText(`$ ${command}\n`, false)
  buffer.readOnly = true
  buffer.locals.set(JTERM_SESSION_LOCAL, true)
  editor.switchToBuffer(buffer.id)

  const { rows, cols } = bodyDims(buffer)
  const started = Date.now()
  const session = await jterm.spawnSession(editor, buffer, shellCommand(command), {
    cwd,
    rows,
    cols,
    label: "jagent",
  })
  jterm.sessions.set(buffer, session)

  let timedOut = false
  while (session.alive) {
    if (Date.now() - started > timeoutMs) {
      timedOut = true
      session.kill()
      break
    }
    await sleep(60)
  }

  await sleep(30)
  const elapsedMs = Date.now() - started
  const output = trimTerminalOutput(buffer.text)
  buffer.readOnly = true
  return {
    buffer,
    command,
    output,
    exitCode: session.exitCode,
    timedOut,
    elapsedMs,
  }
}

export function showJagentTerminal(editor: Editor): boolean {
  const buffer = terminalBuffer(editor)
  if (!buffer) return false
  editor.switchToBuffer(buffer.id)
  return true
}
