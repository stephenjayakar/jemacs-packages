import type { BufferModel, Editor } from "@jemacs/core"
import { completeWithTools } from "./provider"
import { refreshJagentBuffer } from "./render"
import { runJagentTool } from "./tools"
import type { JagentEvent, JagentMessage, JagentSettings } from "./types"

export type JagentAgentState = {
  buffer: BufferModel
  messages: JagentMessage[]
  events: JagentEvent[]
  cwd: string
  running: boolean
  abort?: AbortController
  lastPrompt?: string
}

function at(): string {
  return new Date().toISOString()
}

function event(state: JagentAgentState, evt: JagentEvent): void {
  state.events.push(evt)
  if (state.events.length > 80) state.events.splice(0, state.events.length - 80)
}

function redraw(editor: Editor, state: JagentAgentState, settings: JagentSettings, pending = state.running): void {
  refreshJagentBuffer(state.buffer, state.messages, state.events, settings, state.cwd, pending)
  void editor.changed("jagent-redraw")
}

export async function runJagentAgent(
  editor: Editor,
  state: JagentAgentState,
  settings: JagentSettings,
  prompt: string,
): Promise<void> {
  const trimmed = prompt.trim()
  if (!trimmed) return
  if (state.running) {
    editor.message("Jagent is already running; abort or wait for the current turn")
    return
  }

  state.running = true
  state.lastPrompt = trimmed
  state.abort = new AbortController()
  state.messages.push({ role: "user", content: trimmed, at: at() })
  event(state, { type: "session", text: "turn started", at: at() })
  redraw(editor, state, settings, true)

  try {
    for (let round = 0; round < settings.maxToolRounds; round++) {
      const completion = await completeWithTools(settings, state.messages, state.abort.signal)
      event(state, {
        type: "model",
        text: completion.model ? `model ${completion.model}` : "model response",
        at: at(),
      })
      state.messages.push({
        role: "assistant",
        content: completion.content,
        toolCalls: completion.toolCalls.length ? completion.toolCalls : undefined,
        at: at(),
      })
      redraw(editor, state, settings, completion.toolCalls.length > 0)

      if (completion.toolCalls.length === 0) break

      for (const call of completion.toolCalls) {
        event(state, { type: "tool_start", call, at: at() })
        redraw(editor, state, settings, true)
        const result = await runJagentTool(call, {
          editor,
          cwd: state.cwd,
          bashTimeoutMs: settings.bashTimeoutMs,
        })
        event(state, { type: "tool_end", result, at: at() })
        state.messages.push({
          role: "tool",
          content: result.output,
          result,
          at: at(),
        })
        redraw(editor, state, settings, true)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    event(state, { type: "error", text: message, at: at() })
    state.messages.push({ role: "assistant", content: `Error: ${message}`, at: at() })
    editor.message(`Jagent failed: ${message}`)
  } finally {
    state.running = false
    state.abort = undefined
    event(state, { type: "session", text: "turn finished", at: at() })
    redraw(editor, state, settings, false)
  }
}

export function clearJagentAgent(editor: Editor, state: JagentAgentState, settings: JagentSettings): void {
  state.messages = []
  state.events = [{ type: "session", text: "session cleared", at: at() }]
  state.lastPrompt = undefined
  redraw(editor, state, settings, false)
}

export function abortJagentAgent(editor: Editor, state: JagentAgentState, settings: JagentSettings): void {
  if (!state.running || !state.abort) {
    editor.message("Jagent is idle")
    return
  }
  state.abort.abort()
  event(state, { type: "session", text: "abort requested", at: at() })
  redraw(editor, state, settings, true)
}
