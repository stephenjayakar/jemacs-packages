export type CommandBlock = {
  id: string
  lines: string[]
  ok: boolean
  errorLine?: string
}

export type ControlEvent =
  | { type: "begin"; id: string }
  | { type: "end"; id: string }
  | { type: "error"; id: string; line: string }
  | { type: "output"; paneId: string; data: string }
  | { type: "layout-change"; windowId: string; layout: string }
  | { type: "notification"; name: string; line: string }
  | { type: "line"; line: string }

/** Streaming line parser for tmux -CC output. It deliberately leaves command
 * block ownership to the controller, because asynchronous pane notifications
 * may occur between a block's begin/end guards. */
export class ControlModeParser {
  private pending = ""

  push(chunk: string): ControlEvent[] {
    this.pending = stripControlModeWrappers(this.pending + chunk)
    const events: ControlEvent[] = []
    while (true) {
      const newline = this.pending.indexOf("\n")
      if (newline < 0) break
      const raw = this.pending.slice(0, newline)
      this.pending = this.pending.slice(newline + 1)
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
      if (line) events.push(parseControlLine(line))
    }
    return events
  }

  reset(): void {
    this.pending = ""
  }
}

export function parseControlLine(line: string): ControlEvent {
  let match = line.match(/^%begin\s+\S+\s+(\S+)/)
  if (match) return { type: "begin", id: match[1]! }
  match = line.match(/^%end\s+\S+\s+(\S+)/)
  if (match) return { type: "end", id: match[1]! }
  match = line.match(/^%error\s+\S+\s+(\S+)/)
  if (match) return { type: "error", id: match[1]!, line }
  match = line.match(/^%output\s+(%\d+)\s?(.*)$/)
  if (match) return { type: "output", paneId: match[1]!, data: decodeTmuxOctal(match[2] ?? "") }
  match = line.match(/^%extended-output\s+(%\d+)\s+\d+\s+:\s?(.*)$/)
  if (match) return { type: "output", paneId: match[1]!, data: decodeTmuxOctal(match[2] ?? "") }
  match = line.match(/^%layout-change\s+(\S+)\s+(\S+)/)
  if (match) return { type: "layout-change", windowId: match[1]!, layout: match[2]! }
  match = line.match(/^%(\S+)/)
  if (match) return { type: "notification", name: match[1]!, line }
  return { type: "line", line }
}

export function stripControlModeWrappers(value: string): string {
  return value.replaceAll("\x1bP1000p", "").replaceAll("\x1b\\", "")
}

/** tmux escapes bytes below ASCII 32 and backslash as three octal digits. */
export function decodeTmuxOctal(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)))
}

export function stripProblematicEscapes(value: string): string {
  return value
    .replace(/\x1b[=>]/g, "")
    .replace(/\x1bk[^\x1b]*\x1b\\/g, "")
}

export function tmuxQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function bytesToHexArgs(value: string): string[] {
  return [...new TextEncoder().encode(value)].map(byte => byte.toString(16).toUpperCase().padStart(2, "0"))
}
