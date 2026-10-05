import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BufferModel, Editor, setCustom } from "@jemacs/core"

import {
  dailyNotePath,
  dailyNoteSettings,
  expandTemplate,
  formatMoment,
  install,
  obsidianRegisteredVault,
  obsidianVault,
  todayLink,
} from "./obsidian"

const root = mkdtempSync(join(tmpdir(), "jemacs-obsidian-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function vault(name: string, dailyNotes?: object, files: Record<string, string> = {}): string {
  const dir = join(root, name)
  mkdirSync(join(dir, ".obsidian"), { recursive: true })
  if (dailyNotes) writeFileSync(join(dir, ".obsidian", "daily-notes.json"), JSON.stringify(dailyNotes))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}

const oct4 = new Date(2026, 9, 4, 9, 5, 7)

test("formatMoment covers the daily-note tokens and literal brackets", () => {
  expect(formatMoment(oct4, "YYYY-MM-DD")).toBe("2026-10-04")
  expect(formatMoment(oct4, "dddd, MMMM Do YYYY")).toBe("Sunday, October 4th 2026")
  expect(formatMoment(oct4, "YY/M/D ddd MMM HH:mm:ss")).toBe("26/10/4 Sun Oct 09:05:07")
  expect(formatMoment(oct4, "[Week of] YYYY-MM-DD")).toBe("Week of 2026-10-04")
  expect(formatMoment(new Date(2026, 0, 12), "Do")).toBe("12th")
})

test("daily note settings default like Obsidian and honor folder/format", () => {
  expect(dailyNoteSettings(vault("bare", { autorun: false }))).toEqual({ folder: "", format: "YYYY-MM-DD", template: "" })
  const custom = vault("custom", { folder: "Journal/", format: "YYYY/MM-DD", template: "Templates/Daily" })
  expect(dailyNotePath(custom, oct4)).toBe(join(custom, "Journal", "2026", "10-04.md"))
})

test("expandTemplate fills title, date and time", () => {
  expect(expandTemplate("# {{title}}\n{{date}} {{time}} {{date:dddd}}\n", "2026-10-04", oct4))
    .toBe("# 2026-10-04\n2026-10-04 09:05 Sunday\n")
})

test("the vault is the buffer's own, then obsidian-directory, then Obsidian's registry", () => {
  const main = vault("main")
  const other = vault("other")
  const note = new BufferModel({ name: "n.md", path: join(main, "sub", "n.md"), text: "" })
  setCustom("obsidian-directory", other)
  expect(obsidianVault(note)).toBe(main)
  expect(obsidianVault(new BufferModel({ name: "x", path: join(root, "elsewhere.txt"), text: "" }))).toBe(other)
  setCustom("obsidian-directory", "")

  const registry = join(root, "obsidian.json")
  writeFileSync(registry, JSON.stringify({ vaults: { a: { path: main, ts: 1 }, b: { path: other, ts: 2 }, c: { path: join(root, "gone"), ts: 3 } } }))
  expect(obsidianRegisteredVault(registry)).toBe(other)
  writeFileSync(registry, JSON.stringify({ vaults: { a: { path: main, ts: 1, open: true }, b: { path: other, ts: 2 } } }))
  expect(obsidianRegisteredVault(registry)).toBe(main)
})

test("todayLink uses the vault's daily-note format", () => {
  expect(todayLink(null)).toMatch(/^\[\[\d{4}-\d{2}-\d{2}\]\]$/)
  expect(todayLink(vault("dotted", { format: "YYYY.MM.DD" }))).toMatch(/^\[\[\d{4}\.\d{2}\.\d{2}\]\]$/)
})

test("obsidian-daily-note creates today's note from the template and visits it", async () => {
  const dir = vault("daily", { folder: "Daily", template: "tpl" }, { "tpl.md": "# {{title}}\n", "Daily/.keep": "" })
  const editor = new Editor()
  install(editor)
  editor.scratch("note.md", "", "text").path = join(dir, "note.md")

  await editor.run("obsidian-daily-note")

  const expected = dailyNotePath(dir, new Date())
  const title = formatMoment(new Date(), "YYYY-MM-DD")
  expect(editor.currentBuffer.path).toBe(expected)
  expect(readFileSync(expected, "utf8")).toBe(`# ${title}\n`)

  // Visiting again leaves an edited note alone.
  writeFileSync(expected, "edited\n")
  await editor.run("obsidian-daily-note")
  expect(readFileSync(expected, "utf8")).toBe("edited\n")
})

test("obsidian-insert-today inserts the [[date]] link at point", async () => {
  const editor = new Editor()
  install(editor)
  const buffer = editor.scratch("x.md", "met up ", "text")
  buffer.point = buffer.text.length

  await editor.run("obsidian-insert-today")

  expect(buffer.text).toBe(`met up ${todayLink(obsidianVault(buffer))}`)
})
