import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { Editor } from "@jemacs/core"
import { runCommandInJterm } from "./terminal"
import type { JagentToolCall, JagentToolName, JagentToolResult } from "./types"

type ToolContext = {
  editor: Editor
  cwd: string
  bashTimeoutMs: number
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function resolveToolPath(cwd: string, path: unknown, fallback = "."): string {
  const text = asString(path, fallback)
  return resolve(cwd, text)
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + `\n[truncated ${text.length - maxChars} chars]`
}

async function readFileTool(call: JagentToolCall, ctx: ToolContext): Promise<string> {
  const path = resolveToolPath(ctx.cwd, call.args.path)
  const maxChars = Math.max(1_000, asNumber(call.args.maxChars, 32_000))
  return clip(await readFile(path, "utf8"), maxChars)
}

async function writeFileTool(call: JagentToolCall, ctx: ToolContext): Promise<string> {
  const path = resolveToolPath(ctx.cwd, call.args.path)
  const content = asString(call.args.content)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, "utf8")
  return `wrote ${content.length} chars to ${path}`
}

async function editFileTool(call: JagentToolCall, ctx: ToolContext): Promise<string> {
  const path = resolveToolPath(ctx.cwd, call.args.path)
  const oldText = asString(call.args.oldText)
  const newText = asString(call.args.newText)
  if (!oldText) throw new Error("oldText is required")
  const before = await readFile(path, "utf8")
  const index = before.indexOf(oldText)
  if (index < 0) throw new Error(`oldText not found in ${path}`)
  const after = before.slice(0, index) + newText + before.slice(index + oldText.length)
  await writeFile(path, after, "utf8")
  return `edited ${path}: ${oldText.length} chars -> ${newText.length} chars`
}

async function listFilesTool(call: JagentToolCall, ctx: ToolContext): Promise<string> {
  const root = resolveToolPath(ctx.cwd, call.args.path, ".")
  const maxEntries = Math.max(10, asNumber(call.args.maxEntries, 200))
  const out: string[] = []

  async function walk(dir: string, prefix = ""): Promise<void> {
    if (out.length >= maxEntries) return
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (out.length >= maxEntries) return
      if (entry.name === ".git" || entry.name === "node_modules") continue
      const rel = prefix ? join(prefix, entry.name) : entry.name
      out.push(entry.isDirectory() ? rel + "/" : rel)
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel)
    }
  }

  await walk(root)
  return out.join("\n") || "(empty)"
}

async function grepTool(call: JagentToolCall, ctx: ToolContext): Promise<string> {
  const pattern = asString(call.args.pattern)
  if (!pattern) throw new Error("pattern is required")
  const path = asString(call.args.path, ".")
  const maxMatches = Math.max(1, asNumber(call.args.maxMatches, 120))
  const command = `rg -n --color=never -- ${shellQuote(pattern)} ${shellQuote(path)} | head -n ${maxMatches}`
  const result = await runCommandInJterm(ctx.editor, command, ctx.cwd, ctx.bashTimeoutMs)
  return result.output || "(no matches)"
}

async function bashTool(call: JagentToolCall, ctx: ToolContext): Promise<string> {
  const command = asString(call.args.command)
  if (!command) throw new Error("command is required")
  const timeoutMs = Math.max(1_000, asNumber(call.args.timeoutMs, ctx.bashTimeoutMs))
  const result = await runCommandInJterm(ctx.editor, command, ctx.cwd, timeoutMs)
  const suffix = result.timedOut
    ? `\n[timeout after ${result.elapsedMs} ms]`
    : `\n[exit ${result.exitCode ?? "?"}, ${result.elapsedMs} ms]`
  return result.output + suffix
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const RUNNERS: Record<JagentToolName, (call: JagentToolCall, ctx: ToolContext) => Promise<string>> = {
  read_file: readFileTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  list_files: listFilesTool,
  grep: grepTool,
  bash: bashTool,
}

export async function runJagentTool(call: JagentToolCall, ctx: ToolContext): Promise<JagentToolResult> {
  const started = Date.now()
  try {
    const output = await RUNNERS[call.name](call, ctx)
    return {
      id: call.id,
      name: call.name,
      ok: true,
      output: clip(output, 48_000),
      elapsedMs: Date.now() - started,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      id: call.id,
      name: call.name,
      ok: false,
      output: message,
      elapsedMs: Date.now() - started,
    }
  }
}
