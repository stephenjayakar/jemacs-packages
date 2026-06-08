import type { BufferModel, Editor, PluginContext } from "@jemacs/core"
import { Keymap, createPluginContext, defcustom, getCustom } from "@jemacs/core"
import { defineMode } from "@jemacs/core/modes/mode"
import { runJagentAgent, clearJagentAgent, abortJagentAgent, type JagentAgentState } from "./agent"
import { refreshJagentBuffer, jagentFontLock } from "./render"
import { showJagentTerminal } from "./terminal"
import type { JagentSettings } from "./types"

const JAGENT_BUFFER = "*Jagent*"
const JAGENT_MODE = "jagent-mode"

const stateByEditor = new WeakMap<Editor, JagentAgentState>()

function cwdFor(editor: Editor): string {
  return editor.currentBuffer.directory() ?? process.cwd()
}

function jagentBuffer(editor: Editor): BufferModel | undefined {
  return [...editor.buffers.values()].find(buffer => buffer.name === JAGENT_BUFFER)
}

function settings(): JagentSettings {
  return {
    provider: (getCustom<string>("jagent-provider") || "auto") as JagentSettings["provider"],
    model: getCustom<string>("jagent-model") || "",
    apiKeys: {
      gemini: getCustom<string>("jagent-gemini-api-key") || process.env.GEMINI_API_KEY || "",
      openai: getCustom<string>("jagent-openai-api-key")
        || getCustom<string>("jagent-api-key")
        || process.env.OPENAI_API_KEY
        || "",
      anthropic: getCustom<string>("jagent-anthropic-api-key") || process.env.ANTHROPIC_API_KEY || "",
    },
    maxToolRounds: Math.max(1, getCustom<number>("jagent-max-tool-rounds") ?? 8),
    bashTimeoutMs: Math.max(1_000, getCustom<number>("jagent-bash-timeout-ms") ?? 120_000),
  }
}

function ensureState(editor: Editor): JagentAgentState {
  let state = stateByEditor.get(editor)
  if (state) return state
  const cwd = cwdFor(editor)
  let buffer = jagentBuffer(editor)
  if (!buffer) buffer = editor.scratch(JAGENT_BUFFER, "", JAGENT_MODE)
  else editor.enterMode(buffer, JAGENT_MODE)
  buffer.readOnly = true
  state = {
    buffer,
    messages: [],
    events: [{ type: "session", text: "native agent ready", at: new Date().toISOString() }],
    cwd,
    running: false,
  }
  stateByEditor.set(editor, state)
  refreshJagentBuffer(buffer, state.messages, state.events, settings(), state.cwd, false)
  return state
}

function showJagent(editor: Editor): JagentAgentState {
  const state = ensureState(editor)
  editor.switchToBuffer(state.buffer.id)
  refreshJagentBuffer(state.buffer, state.messages, state.events, settings(), state.cwd, state.running)
  return state
}

function regionText(buffer: BufferModel): string | null {
  if (buffer.mark == null) return null
  const start = Math.min(buffer.mark, buffer.point)
  const end = Math.max(buffer.mark, buffer.point)
  return start === end ? null : buffer.text.slice(start, end)
}

function bufferContext(buffer: BufferModel): string {
  const name = buffer.path ?? buffer.name
  return `Current buffer: ${name}\n\n${buffer.text}`
}

function installMode(): void {
  const map = new Keymap("jagent-mode-map")
  map.bind("i", "jagent-ask")
  map.bind("RET", "jagent-ask")
  map.bind("return", "jagent-ask")
  map.bind("enter", "jagent-ask")
  map.bind("b", "jagent-ask-buffer")
  map.bind("r", "jagent-rerun")
  map.bind("a", "jagent-abort")
  map.bind("c", "jagent-clear")
  map.bind("g", "jagent-redraw")
  map.bind("t", "jagent-terminal")
  map.bind("q", "jagent-bury")
  defineMode({
    name: JAGENT_MODE,
    parent: "text",
    keymap: map,
    fontLock: jagentFontLock,
  })
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  installMode()

  defcustom("jagent-provider", "string", "auto",
    "Jagent provider: auto, gemini, openai, or anthropic.")
  defcustom("jagent-gemini-api-key", "string", "",
    "Gemini API key; empty falls back to GEMINI_API_KEY.")
  defcustom("jagent-openai-api-key", "string", "",
    "OpenAI API key; empty falls back to OPENAI_API_KEY.")
  defcustom("jagent-anthropic-api-key", "string", "",
    "Anthropic API key; empty falls back to ANTHROPIC_API_KEY.")
  defcustom("jagent-api-key", "string", "",
    "Legacy OpenAI API key fallback for Jagent.")
  defcustom("jagent-model", "string", "",
    "Optional model override. Empty uses a provider-specific default.")
  defcustom("jagent-max-tool-rounds", "number", 8,
    "Maximum model/tool loop rounds per Jagent turn.")
  defcustom("jagent-bash-timeout-ms", "number", 120_000,
    "Maximum time for a Jagent bash tool command running in jterm.")

  ctx.command("jagent", ({ editor }) => {
    showJagent(editor)
  }, "Open the native Jagent agent dashboard.")

  ctx.command("jagent-ask", async ({ editor, args }) => {
    const state = showJagent(editor)
    const prompt = args.join(" ") || await editor.prompt("Jagent: ", "", "jagent-prompt")
    if (!prompt) return
    await runJagentAgent(editor, state, settings(), prompt)
  }, "Ask the native Jagent agent.")

  ctx.command("jagent-ask-buffer", async ({ editor, args }) => {
    const source = editor.currentBuffer.mode === JAGENT_MODE
      ? [...editor.buffers.values()].find(buffer => buffer !== editor.currentBuffer) ?? editor.currentBuffer
      : editor.currentBuffer
    const prompt = args.join(" ") || await editor.prompt(`Jagent about ${source.name}: `, "", "jagent-prompt")
    if (!prompt) return
    const state = showJagent(editor)
    await runJagentAgent(editor, state, settings(), `${prompt}\n\n${bufferContext(source)}`)
  }, "Ask Jagent about the current buffer.")

  ctx.command("jagent-ask-region", async ({ editor, args }) => {
    const region = regionText(editor.currentBuffer)
    if (!region) {
      editor.message("Mark a region first")
      return
    }
    const prompt = args.join(" ") || await editor.prompt("Jagent about region: ", "", "jagent-prompt")
    if (!prompt) return
    const state = showJagent(editor)
    await runJagentAgent(editor, state, settings(), `${prompt}\n\nRegion:\n${region}`)
  }, "Ask Jagent about the active region.")

  ctx.command("jagent-rerun", async ({ editor }) => {
    const state = showJagent(editor)
    if (!state.lastPrompt) {
      editor.message("No previous Jagent prompt")
      return
    }
    await runJagentAgent(editor, state, settings(), state.lastPrompt)
  }, "Re-run the last Jagent prompt.")

  ctx.command("jagent-abort", ({ editor }) => {
    abortJagentAgent(editor, ensureState(editor), settings())
  }, "Abort the current native Jagent turn.")

  ctx.command("jagent-clear", ({ editor }) => {
    clearJagentAgent(editor, ensureState(editor), settings())
  }, "Clear the native Jagent transcript.")

  ctx.command("jagent-redraw", ({ editor }) => {
    const state = showJagent(editor)
    refreshJagentBuffer(state.buffer, state.messages, state.events, settings(), state.cwd, state.running)
  }, "Redraw the native Jagent dashboard.")

  ctx.command("jagent-terminal", ({ editor }) => {
    if (!showJagentTerminal(editor)) editor.message("Jagent terminal has not run a command yet")
  }, "Show the managed jterm terminal used by Jagent tools.")

  ctx.command("jagent-bury", ({ editor }) => {
    const buffer = jagentBuffer(editor)
    if (buffer && editor.currentBuffer === buffer) {
      const other = [...editor.buffers.values()].find(candidate => candidate !== buffer)
      if (other) editor.switchToBuffer(other.id)
    }
  }, "Switch away from the Jagent buffer.")

  ctx.key("global", "C-c j", "jagent")
  ctx.key("global", "C-c j a", "jagent-ask")
  ctx.key("global", "C-c j b", "jagent-ask-buffer")
  ctx.key("global", "C-c j r", "jagent-ask-region")
}
