import { existsSync, readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

import type { BufferModel, Editor } from "@jemacs/core"
import { createPluginContext, defcustom, getCustom, type PluginContext } from "@jemacs/core"

defcustom("obsidian-directory", "string", "",
  "Vault for obsidian commands run outside a vault. Empty means Obsidian's open (or most recent) vault.", "obsidian")

export type DailyNoteSettings = {
  folder: string
  format: string
  template: string
}

/** The vault holding PATH: the nearest ancestor with a `.obsidian` folder. */
export function obsidianVaultOf(path: string): string | null {
  let dir = resolve(path)
  for (;;) {
    if (existsSync(join(dir, ".obsidian"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path
}

/** Obsidian's vault registry, `obsidian.json` in its app-data folder. */
function obsidianRegistryPath(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json")
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "obsidian", "obsidian.json")
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "obsidian", "obsidian.json")
}

/** The vault Obsidian has open, else the one it used last. */
export function obsidianRegisteredVault(registry = obsidianRegistryPath()): string | null {
  let vaults: Array<{ path?: string; ts?: number; open?: boolean }>
  try {
    vaults = Object.values(JSON.parse(readFileSync(registry, "utf8")).vaults ?? {})
  } catch {
    return null
  }
  const usable = vaults.filter(vault => typeof vault.path === "string" && existsSync(vault.path))
  const open = usable.find(vault => vault.open)
  const recent = usable.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))[0]
  return (open ?? recent)?.path ?? null
}

/** The vault to act on from BUFFER: its own vault, then `obsidian-directory`, then Obsidian's. */
export function obsidianVault(buffer?: BufferModel): string | null {
  const here = buffer?.path ? dirname(buffer.path) : buffer?.locals.get("default-directory")
  if (typeof here === "string") {
    const vault = obsidianVaultOf(here)
    if (vault) return vault
  }
  const custom = getCustom<string>("obsidian-directory")
  if (custom) return resolve(expandHome(custom))
  return obsidianRegisteredVault()
}

/** The Daily notes core plugin's settings, `.obsidian/daily-notes.json`, with its defaults. */
export function dailyNoteSettings(vault: string): DailyNoteSettings {
  let raw: Record<string, unknown> = {}
  try {
    raw = JSON.parse(readFileSync(join(vault, ".obsidian", "daily-notes.json"), "utf8"))
  } catch {
    // Never configured: every setting is at its default.
  }
  const str = (value: unknown) => typeof value === "string" ? value.trim() : ""
  return { folder: str(raw.folder), format: str(raw.format) || "YYYY-MM-DD", template: str(raw.template) }
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"
  return `${n}${suffix}`
}

/** The moment.js tokens daily-note formats use; `[...]` is literal text. */
export function formatMoment(date: Date, format: string): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0")
  const tokens: Record<string, () => string> = {
    YYYY: () => String(date.getFullYear()),
    YY: () => pad(date.getFullYear() % 100),
    MMMM: () => MONTHS[date.getMonth()]!,
    MMM: () => MONTHS[date.getMonth()]!.slice(0, 3),
    MM: () => pad(date.getMonth() + 1),
    M: () => String(date.getMonth() + 1),
    Do: () => ordinal(date.getDate()),
    DD: () => pad(date.getDate()),
    D: () => String(date.getDate()),
    dddd: () => DAYS[date.getDay()]!,
    ddd: () => DAYS[date.getDay()]!.slice(0, 3),
    d: () => String(date.getDay()),
    HH: () => pad(date.getHours()),
    H: () => String(date.getHours()),
    mm: () => pad(date.getMinutes()),
    ss: () => pad(date.getSeconds()),
  }
  return format.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|d|HH|H|mm|ss/g,
    (token, literal: string | undefined) => literal ?? tokens[token]!())
}

/** Today shifted by OFFSET days, at local midnight. */
export function dayFromToday(offset = 0, now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
}

/** The daily note for DATE: `<vault>/<folder>/<format>.md`. */
export function dailyNotePath(vault: string, date: Date, settings = dailyNoteSettings(vault)): string {
  return join(vault, settings.folder, `${formatMoment(date, settings.format)}.md`)
}

/** Obsidian's core-template substitutions: `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}`. */
export function expandTemplate(template: string, title: string, date: Date): string {
  return template.replace(/\{\{\s*(title|date|time)\s*(?::([^}]*))?\}\}/gi, (_match, name: string, format?: string) => {
    const key = name.toLowerCase()
    if (key === "title") return title
    return formatMoment(date, format?.trim() || (key === "date" ? "YYYY-MM-DD" : "HH:mm"))
  })
}

async function readTemplate(vault: string, template: string): Promise<string> {
  if (!template) return ""
  const file = join(vault, template.endsWith(".md") ? template : `${template}.md`)
  try { return await readFile(file, "utf8") } catch { return "" }
}

/** Visit the daily note for today + OFFSET days, creating it (from the template) like Obsidian. */
export async function obsidianDailyNote(editor: Editor, vault: string, offset = 0): Promise<BufferModel> {
  const settings = dailyNoteSettings(vault)
  const date = dayFromToday(offset)
  const path = dailyNotePath(vault, date, settings)
  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true })
    const template = await readTemplate(vault, settings.template)
    await writeFile(path, expandTemplate(template, basename(path, ".md"), date), { flag: "wx" }).catch(() => {})
  }
  return editor.openFile(path)
}

/** The `[[...]]` link to today's (+ OFFSET) daily note, as nldates' "today" inserts it. */
export function todayLink(vault: string | null, offset = 0): string {
  const format = vault ? dailyNoteSettings(vault).format : "YYYY-MM-DD"
  return `[[${formatMoment(dayFromToday(offset), format)}]]`
}

export function install(editor: Editor, ctx?: PluginContext): void {
  const c = ctx ?? createPluginContext(editor)

  c.command("obsidian-daily-note", async ({ editor, buffer, prefixArgument }) => {
    const vault = obsidianVault(buffer)
    if (!vault) { editor.message("No Obsidian vault; set obsidian-directory"); return }
    const note = await obsidianDailyNote(editor, vault, prefixArgument ?? 0)
    editor.message(`Daily note ${note.path}`)
  }, "Visit today's daily note, creating it if needed. A numeric prefix shifts by that many days.")

  c.command("obsidian-insert-today", ({ buffer, prefixArgument }) => {
    buffer.insert(todayLink(obsidianVault(buffer), prefixArgument ?? 0))
  }, "Insert a [[link]] to today's daily note. A numeric prefix shifts by that many days.")

  c.key("global", "C-c o d", "obsidian-daily-note")
  c.key("global", "C-c o t", "obsidian-insert-today")
}
