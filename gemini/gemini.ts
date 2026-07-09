import { join } from "node:path"
import type { BufferModel, Editor } from "@jemacs/core"
import { jemacsHome } from "../core-path"
import {
  GEMINI_HISTORY,
  GEMINI_PENDING,
  GEMINI_SECTIONS,
  appendTurns,
  formatError,
  geminiFontLock,
  renderPendingBanner,
  renderTurnPair,
  renderWelcomeBanner,
  turnFromJson,
  type GeminiSection,
} from "./render"
import type { GeminiTurn } from "./types"
import { runGeminiJson } from "./run"

type GeminiDeps = {
  Keymap: typeof import("@jemacs/core").Keymap
  defineMode: typeof import("@jemacs/core").defineMode
  defcustom: typeof import("@jemacs/core").defcustom
  getCustom: typeof import("@jemacs/core").getCustom
  defface: typeof import("@jemacs/core").defface
  spawnProcess: typeof import("@jemacs/core").spawnProcess
  whichExecutable: typeof import("@jemacs/core").whichExecutable
}

const GEMINI_BUFFER = "*Gemini*"
const GEMINI_MODE = "gemini-chat"
const GEMINI_LAST_PROMPT = "gemini-last-prompt"
const GEMINI_LAST_STDIN = "gemini-last-stdin"

type HistoryEntry = { prompt: string; turn: GeminiTurn; stdin?: string }

async function loadDeps(): Promise<GeminiDeps> {
  const home = jemacsHome()
  const [keymap, mode, custom, faces, runtime] = await Promise.all([
    import(join(home, "src/kernel/keymap.ts")),
    import(join(home, "src/modes/mode.ts")),
    import(join(home, "src/runtime/custom.ts")),
    import(join(home, "src/runtime/faces.ts")),
    import(join(home, "src/platform/runtime.ts")),
  ])
  return {
    Keymap: keymap.Keymap,
    defineMode: mode.defineMode,
    defcustom: custom.defcustom,
    getCustom: custom.getCustom,
    defface: faces.defface,
    spawnProcess: runtime.spawnProcess,
    whichExecutable: runtime.whichExecutable,
  }
}

function geminiPath(deps: GeminiDeps): string | null {
  const custom = deps.getCustom<string>("gemini-command")
  if (custom) return deps.whichExecutable(custom) ?? (custom.includes("/") ? custom : null)
  return deps.whichExecutable("gemini")
}

function workingDirectory(editor: Editor): string {
  return editor.currentBuffer.directory() ?? process.cwd()
}

function geminiBuffer(editor: Editor): BufferModel | undefined {
  return [...editor.buffers.values()].find(b => b.name === GEMINI_BUFFER)
}

function sections(buffer: BufferModel): GeminiSection[] {
  return (buffer.locals.get(GEMINI_SECTIONS) as GeminiSection[] | undefined) ?? []
}

function history(buffer: BufferModel): HistoryEntry[] {
  return (buffer.locals.get(GEMINI_HISTORY) as HistoryEntry[] | undefined) ?? []
}

function ensureChatBuffer(editor: Editor): BufferModel {
  let buffer = geminiBuffer(editor)
  if (!buffer) {
    const welcome = renderWelcomeBanner()
    buffer = editor.scratch(GEMINI_BUFFER, welcome.text, GEMINI_MODE)
    buffer.readOnly = true
    buffer.locals.set(GEMINI_SECTIONS, welcome.sections)
    buffer.locals.set(GEMINI_HISTORY, [])
    return buffer
  }
  editor.switchToBuffer(buffer.id)
  editor.enterMode(buffer, GEMINI_MODE)
  return buffer
}

function conversationContext(entries: HistoryEntry[], maxTurns = 6): string {
  const recent = entries.slice(-maxTurns)
  if (recent.length === 0) return ""
  const lines = ["Previous conversation:"]
  for (const entry of recent) {
    lines.push(`User: ${entry.prompt}`)
    if (entry.turn.response) lines.push(`Assistant: ${entry.turn.response}`)
    else if (entry.turn.error) lines.push(`Assistant: [error] ${formatError(entry.turn.error)}`)
  }
  lines.push("")
  return lines.join("\n")
}

function stripPending(buffer: BufferModel): void {
  if (!buffer.locals.get(GEMINI_PENDING)) return
  const pendingLen = buffer.locals.get(GEMINI_PENDING) as number
  const oldSections = sections(buffer)
  const wasReadOnly = buffer.readOnly
  buffer.readOnly = false
  buffer.setText(buffer.text.slice(0, buffer.text.length - pendingLen), false)
  buffer.readOnly = wasReadOnly
  buffer.locals.set(GEMINI_SECTIONS, oldSections.filter(s => s.end <= buffer.text.length))
  buffer.locals.delete(GEMINI_PENDING)
}

async function askGemini(
  editor: Editor,
  deps: GeminiDeps,
  prompt: string,
  options: { stdin?: string; showBuffer?: boolean } = {},
): Promise<void> {
  const bin = geminiPath(deps)
  if (!bin) {
    editor.message("gemini CLI not found — set `gemini-command` or install gemini")
    return
  }
  const trimmed = prompt.trim()
  if (!trimmed) {
    editor.message("Empty prompt")
    return
  }

  const buffer = ensureChatBuffer(editor)
  if (options.showBuffer !== false) editor.switchToBuffer(buffer.id)

  const at = new Date().toISOString()
  const pending = renderPendingBanner()
  const pendingSections = appendTurns(buffer, sections(buffer), pending)
  buffer.locals.set(GEMINI_SECTIONS, pendingSections)
  buffer.locals.set(GEMINI_PENDING, pending.text.length)
  buffer.point = buffer.text.length
  void editor.changed("gemini-pending")

  const cwd = workingDirectory(editor)
  const historyEntries = history(buffer)
  const context = conversationContext(historyEntries)
  const fullPrompt = context ? `${context}User: ${trimmed}` : trimmed

  try {
    const json = await runGeminiJson({
      prompt: fullPrompt,
      stdin: options.stdin,
      cwd,
      model: deps.getCustom<string>("gemini-model") || undefined,
      yolo: deps.getCustom<boolean>("gemini-yolo") === true,
      geminiPath: bin,
      spawn: deps.spawnProcess,
    })

    stripPending(buffer)
    const turn = turnFromJson(trimmed, json, at)
    const rendered = renderTurnPair(trimmed, turn)
    const nextSections = appendTurns(buffer, sections(buffer), rendered)
    buffer.locals.set(GEMINI_SECTIONS, nextSections)
    const nextHistory = [...historyEntries, { prompt: trimmed, turn, stdin: options.stdin }]
    buffer.locals.set(GEMINI_HISTORY, nextHistory)
    buffer.locals.set(GEMINI_LAST_PROMPT, trimmed)
    buffer.locals.set(GEMINI_LAST_STDIN, options.stdin ?? "")
    buffer.point = buffer.text.length

    if (turn.error) editor.message(`Gemini: ${formatError(turn.error)}`)
    else editor.message(`Gemini · ${turn.model ?? "model"} · ${turn.latencyMs ?? "?"} ms`)
  } catch (error) {
    stripPending(buffer)
    const message = error instanceof Error ? error.message : String(error)
    const turn: GeminiTurn = {
      role: "assistant",
      prompt: trimmed,
      error: { type: "JemacsError", message },
      at,
    }
    const rendered = renderTurnPair(trimmed, turn)
    const nextSections = appendTurns(buffer, sections(buffer), rendered)
    buffer.locals.set(GEMINI_SECTIONS, nextSections)
    buffer.point = buffer.text.length
    editor.message(`Gemini failed: ${message}`)
  }

  void editor.changed("gemini-response")
}

function regionText(buffer: BufferModel): string | null {
  if (buffer.mark == null) return null
  const start = Math.min(buffer.mark, buffer.point)
  const end = Math.max(buffer.mark, buffer.point)
  if (start === end) return null
  return buffer.text.slice(start, end)
}

function bufferContext(buffer: BufferModel): { stdin?: string; label: string } {
  const name = buffer.path ?? buffer.name
  const header = `File: ${name}\n\n`
  return { stdin: header + buffer.text, label: name }
}

function installFaces(deps: GeminiDeps): void {
  deps.defface("gemini-user-header", { fg: "#83a598", bold: true }, "Gemini chat user turn header.")
  deps.defface("gemini-user-body", { fg: "#fabd2f" }, "Gemini chat user message body.")
  deps.defface("gemini-response-header", { fg: "#b8bb26", bold: true }, "Gemini chat assistant turn header.")
  deps.defface("gemini-pending", { fg: "#d3869b", italic: true }, "Gemini chat pending indicator.")
}

function installMode(deps: GeminiDeps): void {
  const map = new deps.Keymap("gemini-chat-map")
  map.bind("q", "gemini-chat-bury")
  map.bind("r", "gemini-chat-follow-up")
  map.bind("RET", "gemini-chat-follow-up")
  map.bind("return", "gemini-chat-follow-up")
  map.bind("enter", "gemini-chat-follow-up")
  map.bind("g", "gemini-chat-refresh")
  map.bind("C-c C-k", "gemini-chat-clear")
  deps.defineMode({
    name: GEMINI_MODE,
    parent: "text",
    keymap: map,
    fontLock: geminiFontLock,
  })
}

export async function install(editor: Editor): Promise<void> {
  const deps = await loadDeps()
  installFaces(deps)
  installMode(deps)

  deps.defcustom("gemini-command", "string", "gemini", "Executable name or path for the Gemini CLI.")
  deps.defcustom("gemini-model", "string", "", "Optional Gemini model override (empty = CLI default).")
  deps.defcustom("gemini-yolo", "boolean", false, "Pass --yolo to auto-approve Gemini tool actions.")

  editor.command("gemini-ask", async ({ editor, args }) => {
    const prompt = args.join(" ") || await editor.prompt("Gemini: ", "", "gemini-prompt")
    if (!prompt) return
    await askGemini(editor, deps, prompt)
  }, "Ask Gemini (JSON mode) and show the response in *Gemini*.")

  editor.command("gemini-ask-buffer", async ({ editor, args }) => {
    const { stdin, label } = bufferContext(editor.currentBuffer)
    const prompt = args.join(" ") || await editor.prompt(`Gemini about ${label}: `, "", "gemini-prompt")
    if (!prompt) return
    await askGemini(editor, deps, prompt, { stdin })
  }, "Ask Gemini about the current buffer contents.")

  editor.command("gemini-ask-region", async ({ editor, args }) => {
    const region = regionText(editor.currentBuffer)
    if (!region) {
      editor.message("Mark a region first")
      return
    }
    const prompt = args.join(" ") || await editor.prompt("Gemini about region: ", "", "gemini-prompt")
    if (!prompt) return
    await askGemini(editor, deps, prompt, { stdin: `Region:\n\n${region}` })
  }, "Ask Gemini about the active region.")

  editor.command("gemini-chat-follow-up", async ({ editor, buffer }) => {
    if (buffer.mode !== GEMINI_MODE) return
    const prompt = await editor.prompt("Follow-up: ", "", "gemini-prompt")
    if (!prompt) return
    await askGemini(editor, deps, prompt)
  }, "Send a follow-up prompt in the Gemini chat buffer.")

  editor.command("gemini-chat-refresh", async ({ editor, buffer }) => {
    if (buffer.mode !== GEMINI_MODE) return
    const prompt = buffer.locals.get(GEMINI_LAST_PROMPT) as string | undefined
    if (!prompt) {
      editor.message("No previous Gemini prompt")
      return
    }
    const stdin = buffer.locals.get(GEMINI_LAST_STDIN) as string | undefined
    await askGemini(editor, deps, prompt, { stdin: stdin || undefined })
  }, "Re-run the last Gemini prompt.")

  editor.command("gemini-chat-clear", ({ editor, buffer }) => {
    if (buffer.mode !== GEMINI_MODE) return
    const welcome = renderWelcomeBanner()
    const wasReadOnly = buffer.readOnly
    buffer.readOnly = false
    buffer.setText(welcome.text, false)
    buffer.readOnly = wasReadOnly
    buffer.locals.set(GEMINI_SECTIONS, welcome.sections)
    buffer.locals.set(GEMINI_HISTORY, [])
    buffer.locals.delete(GEMINI_LAST_PROMPT)
    buffer.locals.delete(GEMINI_LAST_STDIN)
    buffer.locals.delete(GEMINI_PENDING)
    buffer.point = 0
    void editor.changed("gemini-clear")
  }, "Clear the Gemini chat buffer.")

  editor.command("gemini-chat-bury", ({ editor }) => {
    const buffer = geminiBuffer(editor)
    if (buffer && editor.currentBuffer === buffer) {
      const other = [...editor.buffers.values()].find(b => b !== buffer)
      if (other) editor.switchToBuffer(other.id)
    }
  }, "Switch away from the Gemini chat buffer.")

  editor.key("C-c g g", "gemini-ask")
  editor.key("C-c g b", "gemini-ask-buffer")
  editor.key("C-c g r", "gemini-ask-region")
}
