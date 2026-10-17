import { existsSync } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path"

import type { BufferModel, Editor, PluginContext } from "@jemacs/core"
import { defcustom, getCustom, Keymap } from "@jemacs/core"

defcustom("obsidian-tag-view-default-tag", "string", "journal",
  "Tag `obsidian-tag-view' offers when the prompt is left empty.", "obsidian")
defcustom("obsidian-date-properties", { kind: "repeat", item: "string" },
  ["date", "Written on override", "Written on", "created", "Created time"],
  "Frontmatter properties holding a note's date, most authoritative first. Notes without one fall back to a YYYY-MM-DD in the file name, a [[YYYY-MM-DD]] daily-note link near the top, then the file's creation time.",
  "obsidian")

export type Frontmatter = Record<string, string | string[]>

export type VaultNote = {
  path: string
  title: string
  props: Frontmatter
  /** The note without its frontmatter. */
  body: string
  /** 0-based source line where `body` starts. */
  bodyLine: number
  tags: Set<string>
  birthMs: number
}

export type Vault = {
  root: string
  notes: VaultNote[]
  /** Non-markdown files by base name, for resolving `![[image.png]]` embeds. */
  attachments: Map<string, string>
}

export type TaggedNote = VaultNote & { date: Date; day: string }

/** Split leading `---` YAML frontmatter off TEXT, parsing the flat key/value and list subset notes use. */
export function splitFrontmatter(text: string): { props: Frontmatter; body: string; bodyLine: number } {
  const lines = text.split("\n")
  if (lines[0]?.trimEnd() !== "---") return { props: {}, body: text, bodyLine: 0 }
  const close = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line))
  if (close < 0) return { props: {}, body: text, bodyLine: 0 }
  const props: Frontmatter = {}
  let last: string | null = null
  const unquote = (value: string) => value.trim().replace(/^(["'])(.*)\1$/, "$2")
  for (const line of lines.slice(1, close)) {
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && last) {
      const prev = props[last]
      props[last] = [...(Array.isArray(prev) ? prev : prev ? [prev] : []), unquote(item[1]!)]
      continue
    }
    const pair = /^([^:#\s][^:]*):\s*(.*)$/.exec(line)
    if (!pair) continue
    last = pair[1]!.trim()
    const value = pair[2]!.trim()
    props[last] = value.startsWith("[") && value.endsWith("]")
      ? value.slice(1, -1).split(",").map(unquote).filter(Boolean)
      : unquote(value)
  }
  return { props, body: lines.slice(close + 1).join("\n"), bodyLine: close + 1 }
}

function prop(props: Frontmatter, name: string): string | string[] | undefined {
  const key = Object.keys(props).find(k => k.toLowerCase() === name.toLowerCase())
  return key == null ? undefined : props[key]
}

/** Obsidian's tags for a note, lowercased, with each nested tag's parents (`a/b` also yields `a`). */
export function noteTags(props: Frontmatter, body: string): Set<string> {
  const tags = new Set<string>()
  const add = (raw: string) => {
    const tag = raw.replace(/^#/, "").trim().toLowerCase()
    if (!tag || /^[\d/]+$/.test(tag)) return
    const parts = tag.split("/")
    for (let i = 1; i <= parts.length; i++) tags.add(parts.slice(0, i).join("/"))
  }
  for (const name of ["tags", "tag"]) {
    const value = prop(props, name)
    for (const entry of Array.isArray(value) ? value : value ? [value] : []) {
      for (const piece of entry.split(/[,\s]+/)) add(piece)
    }
  }
  const prose = body.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "").replace(/`[^`\n]*`/g, "")
  for (const match of prose.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) add(match[1]!)
  return tags
}

function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseDate(value: string): Date | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** When NOTE was written: a date property, a dated file name, a daily-note link at the top, else its creation time. */
export function noteDate(note: VaultNote, properties = getCustom<string[]>("obsidian-date-properties") ?? []): Date {
  for (const name of properties) {
    const value = prop(note.props, name)
    const date = typeof value === "string" && value ? parseDate(value) : null
    if (date) return date
  }
  const named = /^(\d{4}-\d{2}-\d{2})/.exec(note.title)
  if (named) return parseDate(named[1]!)!
  const linked = /\[\[(\d{4}-\d{2}-\d{2})(?:[|\]])/.exec(note.body.split("\n", 5).join("\n"))
  if (linked) return parseDate(linked[1]!)!
  return new Date(note.birthMs)
}

const SKIP_DIRS = new Set(["node_modules"])

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!)
  }))
}

/** Read every note in the vault at ROOT. Skips dot folders (`.obsidian`, `.trash`) and Emacs autosave/lock files. */
export async function scanVault(root: string): Promise<Vault> {
  const markdown: string[] = []
  const attachments = new Map<string, string>()
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    await Promise.all(entries.map(async entry => {
      if (entry.name.startsWith(".")) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path)
      } else if (extname(entry.name).toLowerCase() === ".md") {
        if (!entry.name.startsWith("#")) markdown.push(path)
      } else {
        // Obsidian resolves an ambiguous embed to the copy nearest the vault root.
        const known = attachments.get(entry.name)
        if (!known || relative(root, path).split("/").length < relative(root, known).split("/").length) {
          attachments.set(entry.name, path)
        }
      }
    }))
  }
  await walk(root)
  const notes: VaultNote[] = []
  await pool(markdown, 64, async path => {
    try {
      const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)])
      const { props, body, bodyLine } = splitFrontmatter(text)
      notes.push({
        path,
        title: basename(path, ".md"),
        props,
        body,
        bodyLine,
        tags: noteTags(props, body),
        birthMs: info.birthtimeMs || info.mtimeMs,
      })
    } catch {
      // Vanished or unreadable mid-scan: leave it out.
    }
  })
  return { root, notes, attachments }
}

/** Every tag in VAULT, most used first. */
export function vaultTags(vault: Vault): string[] {
  const counts = new Map<string, number>()
  for (const note of vault.notes) for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag)
}

/** Notes in VAULT tagged TAG (nested tags included), newest first. */
export function notesWithTag(vault: Vault, tag: string): TaggedNote[] {
  const want = tag.replace(/^#/, "").toLowerCase()
  return vault.notes
    .filter(note => note.tags.has(want))
    .map(note => {
      const date = noteDate(note)
      return { ...note, date, day: localDay(date) }
    })
    .sort((a, b) => b.day.localeCompare(a.day) || b.date.getTime() - a.date.getTime() || b.birthMs - a.birthMs)
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i

/** Point NOTE's image embeds at absolute paths, since the feed buffer has no folder of its own. Keeps line count. */
export function absolutizeImages(body: string, notePath: string, vault: Vault): string {
  const locate = (target: string): string | null => {
    if (isAbsolute(target)) return null
    return [resolve(dirname(notePath), target), resolve(vault.root, target)].find(path => existsSync(path))
      ?? vault.attachments.get(basename(target)) ?? null
  }
  return body
    .replace(/!\[\[([^\]|\n]+?)((?:\|[^\]\n]*)?)\]\]/g, (whole, target: string, alt: string) => {
      if (!IMAGE_EXT.test(target.trim())) return whole
      const path = locate(target.trim())
      return path ? `![[${path}${alt}]]` : whole
    })
    .replace(/!\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^)\s\n]+))((?:\s+"[^"\n]*")?)\)/g,
      (whole, alt: string, angled?: string, bare?: string, title = "") => {
        const target = angled ?? bare ?? ""
        if (/^[a-z]+:/i.test(target) || !IMAGE_EXT.test(target)) return whole
        let decoded = target
        try { decoded = decodeURIComponent(target) } catch {}
        const path = locate(decoded)
        return path ? `![${alt}](<${path}>${title})` : whole
      })
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

type Entry = {
  path: string
  /** Buffer offset of the entry's heading. */
  start: number
  /** Buffer offset and 1-based buffer line where the note's body begins. */
  bodyStart: number
  bodyBufferLine: number
  /** 0-based source line shown on `bodyBufferLine`. */
  bodySourceLine: number
}

type TagViewState = {
  vaultRoot: string
  tag: string
  vault: Vault
  notes: TaggedNote[]
  loaded: number
  entries: Entry[]
  loading: boolean
}

const STATE = "obsidian-tag-view"
const MODE = "obsidian-tag-view-mode"
/** Load roughly this many characters of notes at a time... */
const BATCH_CHARS = 60_000
/** ...whenever point gets this close to the end of what is loaded. */
const LOAD_AHEAD_CHARS = 30_000

function stateOf(buffer: BufferModel): TagViewState | null {
  return (buffer.locals.get(STATE) as TagViewState | undefined) ?? null
}

function countLines(text: string): number {
  let n = 0
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++
  return n
}

/** Append the next batch of notes to BUFFER. Returns whether anything was added. */
function loadMore(buffer: BufferModel, state: TagViewState, minChars = BATCH_CHARS): boolean {
  if (state.loaded >= state.notes.length) return false
  let chunk = ""
  let offset = buffer.text.length
  let line = buffer.lineAt(offset) + 1
  while (state.loaded < state.notes.length && chunk.length < minChars) {
    const note = state.notes[state.loaded++]!
    const separator = state.entries.length > 0 ? "\n---\n\n" : ""
    const heading = note.title === note.day ? `# ${note.day}\n` : `# ${note.title}\n`
    const folder = relative(state.vaultRoot, dirname(note.path))
    const meta = `_${DAYS[note.date.getDay()]}, ${note.day}${folder ? ` · ${folder}` : ""}_\n\n`
    const lines = note.body.split("\n")
    let skip = 0
    while (skip < lines.length - 1 && lines[skip]!.trim() === "") skip++
    const body = absolutizeImages(lines.slice(skip).join("\n").trimEnd(), note.path, state.vault) + "\n"
    const start = offset + chunk.length + separator.length
    const head = separator + heading + meta
    state.entries.push({
      path: note.path,
      start,
      bodyStart: offset + chunk.length + head.length,
      bodyBufferLine: line + countLines(head),
      bodySourceLine: note.bodyLine + skip,
    })
    line += countLines(head) + countLines(body)
    chunk += head + body
  }
  buffer.append(chunk)
  return true
}

function entryAt(state: TagViewState, point: number): Entry | null {
  let lo = 0
  let hi = state.entries.length - 1
  let found: Entry | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (state.entries[mid]!.start <= point) { found = state.entries[mid]!; lo = mid + 1 }
    else hi = mid - 1
  }
  return found
}

function offsetAt(text: string, line: number, col: number): number {
  let offset = 0
  for (let i = 0; i < line; i++) {
    const next = text.indexOf("\n", offset)
    if (next < 0) return text.length
    offset = next + 1
  }
  const end = text.indexOf("\n", offset)
  return Math.min(offset + col, end < 0 ? text.length : end)
}

/** Fill BUFFER with VAULT's notes tagged TAG, keeping point when refreshing the same feed. */
function render(editor: Editor, buffer: BufferModel, vault: Vault, tag: string): TagViewState {
  const notes = notesWithTag(vault, tag)
  const previous = stateOf(buffer)
  const point = previous?.tag === tag ? buffer.point : 0
  const state: TagViewState = { vaultRoot: vault.root, tag, vault, notes, loaded: 0, entries: [], loading: false }
  buffer.setText(`_${notes.length} notes tagged #${tag}, newest first_\n\n`, false)
  buffer.locals.set(STATE, state)
  loadMore(buffer, state, Math.max(BATCH_CHARS, point + LOAD_AHEAD_CHARS))
  buffer.point = Math.min(point, buffer.text.length)
  void editor.changed("obsidian-tag-view")
  return state
}

/** Show the notes in VAULTROOT tagged TAG in one scrolling buffer, newest first. */
export async function obsidianTagView(editor: Editor, vaultRoot: string, tag: string, vault?: Vault): Promise<BufferModel> {
  tag = tag.replace(/^#/, "").toLowerCase()
  const scanned = vault ?? await scanVault(vaultRoot)
  const buffer = editor.scratch(`*obsidian #${tag}*`, "", "gfm-view-mode")
  buffer.readOnly = true
  // A path inside the vault lets wiki links resolve by name across the vault; the
  // buffer stays a non-file scratch buffer, so nothing saves or reverts it.
  buffer.path = join(vaultRoot, `.obsidian-tag-view-${tag.replace(/\//g, "-")}.md`)
  buffer.locals.set("default-directory", vaultRoot)
  editor.enableMinorMode(MODE, { buffer })
  render(editor, buffer, scanned, tag)
  return buffer
}

async function visitEntry(editor: Editor, buffer: BufferModel, otherWindow: boolean): Promise<void> {
  const state = stateOf(buffer)
  const entry = state && entryAt(state, buffer.point)
  if (!entry) { editor.message("No note here"); return }
  let line = entry.bodySourceLine
  let col = 0
  if (buffer.point >= entry.bodyStart) {
    const here = buffer.lineCol()
    line += here.line - entry.bodyBufferLine
    col = here.col - 1
  }
  if (otherWindow) editor.displayBufferInOtherWindow(buffer.id, { select: true })
  const note = await editor.openFile(entry.path)
  note.point = offsetAt(note.text, line, Math.max(0, col))
}

/** VAULTOF picks the vault a command run from a buffer acts on. */
export function installTagView(editor: Editor, ctx: PluginContext, vaultOf: (buffer: BufferModel) => string | null): void {
  const keymap = new Keymap(`${MODE}-map`)
  for (const key of ["enter", "return", "C-m"]) keymap.bind(key, "obsidian-tag-view-visit")
  keymap.bind("o", "obsidian-tag-view-visit-other-window")
  keymap.bind("n", "obsidian-tag-view-next")
  keymap.bind("p", "obsidian-tag-view-previous")
  keymap.bind("g", "obsidian-tag-view-refresh")
  keymap.bind("q", "quit-window")
  ctx.minorMode({ name: MODE, lighter: " Tags", keymap })

  ctx.command("obsidian-tag-view", async ({ editor, buffer, args }) => {
    const root = vaultOf(buffer)
    if (!root) { editor.message("No Obsidian vault; set obsidian-directory"); return }
    let tag = args[0]
    let vault: Vault | undefined
    if (tag == null) {
      vault = await scanVault(root)
      const fallback = getCustom<string>("obsidian-tag-view-default-tag") || "journal"
      const input = await editor.completingRead(`Tag (default ${fallback}): `, {
        collection: vaultTags(vault).map(tag => `#${tag}`),
        history: "obsidian-tag",
      })
      if (input == null) return
      tag = input.trim() || fallback
    }
    const view = await obsidianTagView(editor, root, tag, vault)
    editor.message(`${stateOf(view)?.notes.length ?? 0} notes tagged #${tag.replace(/^#/, "")}`)
  }, "Show every note in the vault with a tag, newest first, in one buffer that loads more as you scroll.")

  ctx.command("obsidian-journal", async ({ editor }) => {
    await editor.run("obsidian-tag-view", [getCustom<string>("obsidian-tag-view-default-tag") || "journal"])
  }, "Show the notes tagged with `obsidian-tag-view-default-tag' (#journal), newest first.")

  ctx.command("obsidian-tag-view-visit", ({ editor, buffer }) => visitEntry(editor, buffer, false),
    "Visit the note under point, at the matching line.")
  ctx.command("obsidian-tag-view-visit-other-window", ({ editor, buffer }) => visitEntry(editor, buffer, true),
    "Visit the note under point in another window.")

  ctx.command("obsidian-tag-view-next", ({ editor, buffer, prefixArgument }) => {
    const state = stateOf(buffer)
    if (!state) return
    for (let n = Math.max(1, prefixArgument ?? 1); n > 0; n--) {
      let next = state.entries.find(entry => entry.start > buffer.point)
      if (!next && loadMore(buffer, state)) next = state.entries.find(entry => entry.start > buffer.point)
      if (!next) { editor.message("No more notes"); return }
      buffer.point = next.start
    }
    editor.setSelectedWindowStartLine(buffer.lineAt(buffer.point))
  }, "Move to the next note, scrolling it to the top of the window.")

  ctx.command("obsidian-tag-view-previous", ({ editor, buffer, prefixArgument }) => {
    const state = stateOf(buffer)
    if (!state) return
    for (let n = Math.max(1, prefixArgument ?? 1); n > 0; n--) {
      const prev = entryAt(state, buffer.point - 1)
      if (prev) buffer.point = prev.start
    }
    editor.setSelectedWindowStartLine(buffer.lineAt(buffer.point))
  }, "Move to the previous note, scrolling it to the top of the window.")

  ctx.command("obsidian-tag-view-refresh", async ({ editor, buffer }) => {
    const state = stateOf(buffer)
    if (!state) return
    render(editor, buffer, await scanVault(state.vaultRoot), state.tag)
    editor.message(`Refreshed #${state.tag}`)
  }, "Re-read the vault and rebuild this tag view.")

  // Infinite scroll. Wheel scrolling moves point without running a command, so watch
  // redisplay rather than post-command-hook.
  ctx.onDispose(editor.events.on("changed", () => {
    const buffer = editor.currentBuffer
    const state = stateOf(buffer)
    if (!state || state.loading || state.loaded >= state.notes.length) return
    if (buffer.text.length - buffer.point > LOAD_AHEAD_CHARS) return
    state.loading = true
    try {
      if (loadMore(buffer, state)) void editor.changed("obsidian-tag-view-load")
    } finally {
      state.loading = false
    }
  }))

  ctx.key("global", "C-c o #", "obsidian-tag-view")
  ctx.key("global", "C-c o j", "obsidian-journal")
}
