import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Editor } from "@jemacs/core"

import { install } from "./obsidian"
import { absolutizeImages, noteDate, noteTags, notesWithTag, scanVault, splitFrontmatter, vaultTags } from "./tag-view"

const root = mkdtempSync(join(tmpdir(), "jemacs-obsidian-tags-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function vault(name: string, files: Record<string, string>): string {
  const dir = join(root, name)
  mkdirSync(join(dir, ".obsidian"), { recursive: true })
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}

test("splitFrontmatter parses scalars, lists and inline arrays", () => {
  const { props, body, bodyLine } = splitFrontmatter("---\nTitle: \"Hi\"\ntags:\n  - a\n  - b\nother: [x, 'y']\n---\nbody\n")
  expect(props).toEqual({ Title: "Hi", tags: ["a", "b"], other: ["x", "y"] })
  expect(body).toBe("body\n")
  expect(bodyLine).toBe(7)
  expect(splitFrontmatter("no front\n")).toEqual({ props: {}, body: "no front\n", bodyLine: 0 })
})

test("noteTags reads inline and frontmatter tags, nested parents, and skips code", () => {
  const tags = noteTags({ tags: ["Work"] }, "#journal #Life/Family and email@x.com#nope\n`#code`\n```\n#fenced\n```\n# Heading #123")
  expect([...tags].sort()).toEqual(["journal", "life", "life/family", "work"])
  expect(noteTags({}, "#journaling").has("journal")).toBe(false)
})

test("noteDate prefers date properties, then file name, then a daily link, then birth time", () => {
  const base = { path: "/v/x.md", title: "x", body: "", bodyLine: 0, tags: new Set<string>(), birthMs: new Date(2020, 0, 2).getTime() }
  const props = ["Written on override", "Written on"]
  expect(noteDate({ ...base, props: { "Written on": "2024-12-01T15:06:00", "Written on override": "2024-08-12" } }, props))
    .toEqual(new Date(2024, 7, 12))
  expect(noteDate({ ...base, props: {}, title: "2026-01-02 talked" }, props)).toEqual(new Date(2026, 0, 2))
  expect(noteDate({ ...base, props: {}, body: "#journal [[2025-01-22]]\n" }, props)).toEqual(new Date(2025, 0, 22))
  expect(noteDate({ ...base, props: {} }, props)).toEqual(new Date(2020, 0, 2))
})

test("absolutizeImages points embeds and relative images at real files, keeping lines", async () => {
  const dir = vault("images", {
    "notes/a.md": "x",
    "notes/pic.png": "",
    "attachments/IMG_1.png": "",
  })
  const scanned = await scanVault(dir)
  const body = "![[IMG_1.png|200]]\n![alt](pic.png)\n![[Other note]]\n![](https://x/y.png)\n![[missing.png]]"
  expect(absolutizeImages(body, join(dir, "notes", "a.md"), scanned)).toBe([
    `![[${join(dir, "attachments", "IMG_1.png")}|200]]`,
    `![alt](<${join(dir, "notes", "pic.png")}>)`,
    "![[Other note]]",
    "![](https://x/y.png)",
    "![[missing.png]]",
  ].join("\n"))
})

const journal = {
  "old.md": "#journal\nold body\n",
  "Notion/Mid.md": "---\nWritten on: 2025-06-01T10:00:00\n---\n#journal\n\nmid line one\nmid line two\n",
  "2026-03-04 newest.md": "#journal\nnewest body\n",
  "other.md": "#writing\nnot journal\n",
  "#autosave.md#": "#journal\n",
  ".trash/gone.md": "#journal\n",
}

test("scanVault and notesWithTag sort a tag's notes newest first", async () => {
  const dir = vault("journal", { ...journal, "old.md": "---\ndate: 2020-01-01\n---\n#journal\nold body\n" })
  const scanned = await scanVault(dir)
  expect(notesWithTag(scanned, "#Journal").map(note => note.title)).toEqual(["2026-03-04 newest", "Mid", "old"])
  expect(vaultTags(scanned)).toEqual(["journal", "writing"])
})

test("obsidian-tag-view shows every tagged note in one buffer and RET visits the source line", async () => {
  const dir = vault("feed", { ...journal, "old.md": "---\ndate: 2020-01-01\n---\n#journal\nold body\n" })
  const editor = new Editor()
  install(editor)
  editor.scratch("start.md", "", "text").path = join(dir, "start.md")

  await editor.run("obsidian-tag-view", ["journal"])

  const feed = editor.currentBuffer
  expect(feed.name).toBe("*obsidian #journal*")
  expect(feed.readOnly).toBe(true)
  const text = feed.text
  expect(text.indexOf("# 2026-03-04 newest")).toBeLessThan(text.indexOf("# Mid"))
  expect(text.indexOf("# Mid")).toBeLessThan(text.indexOf("# old"))
  expect(text).not.toContain("not journal")
  expect(text).not.toContain("Written on")

  feed.point = text.indexOf("mid line two") + 4
  await editor.run("obsidian-tag-view-visit")
  const note = editor.currentBuffer
  expect(note.path).toBe(join(dir, "Notion", "Mid.md"))
  expect(note.lineCol()).toEqual({ line: 7, col: 5 })
})

test("n and p walk notes, and scrolling near the end loads the next batch", async () => {
  const files: Record<string, string> = {}
  const filler = "lorem ipsum dolor sit amet\n".repeat(400)
  for (let day = 1; day <= 28; day++) files[`2025-02-${String(day).padStart(2, "0")}.md`] = `#journal\n${filler}`
  const dir = vault("many", files)
  const editor = new Editor()
  install(editor)
  editor.scratch("start.md", "", "text").path = join(dir, "start.md")
  await editor.run("obsidian-tag-view", ["journal"])
  const feed = editor.currentBuffer

  const initial = feed.text.length
  expect(feed.text).toContain("# 2025-02-28")
  expect(feed.text).not.toContain("# 2025-02-01")

  await editor.run("obsidian-tag-view-next")
  expect(feed.text.slice(feed.point).startsWith("# 2025-02-28")).toBe(true)
  await editor.run("obsidian-tag-view-next")
  expect(feed.text.slice(feed.point).startsWith("# 2025-02-27")).toBe(true)
  await editor.run("obsidian-tag-view-previous")
  expect(feed.text.slice(feed.point).startsWith("# 2025-02-28")).toBe(true)

  feed.point = feed.text.length
  await editor.changed("test")
  expect(feed.text.length).toBeGreaterThan(initial)

  for (let i = 0; i < 40 && !feed.text.includes("# 2025-02-01"); i++) {
    feed.point = feed.text.length
    await editor.changed("test")
  }
  expect(feed.text).toContain("# 2025-02-01")
})
