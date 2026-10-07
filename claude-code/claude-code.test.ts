import { afterAll, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { BufferModel, Editor, listWindowLeaves, setCustom } from "@jemacs/core"
import { jemacsHome } from "../core-path"
import {
  claudeBufferName,
  claudeBuffers,
  CLAUDE_DIRECTORY_LOCAL,
  fileReference,
  install,
  instancesFor,
  promptBytes,
} from "./index"

const dirs: string[] = []
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

test("buffer names follow claude-code.el's *claude:DIR* convention", () => {
  expect(claudeBufferName(join(homedir(), "src/app"))).toBe("*claude:~/src/app/*")
  expect(claudeBufferName("/tmp/x/", "review")).toBe("*claude:/tmp/x/:review*")
})

test("file references are root-relative with line ranges", () => {
  expect(fileReference("/repo/src/a.ts", "/repo")).toBe("@src/a.ts")
  expect(fileReference("/repo/src/a.ts", "/repo", 4)).toBe("@src/a.ts#L4")
  expect(fileReference("/repo/src/a.ts", "/repo", 4, 9)).toBe("@src/a.ts#L4-9")
  expect(fileReference("/elsewhere/b.ts", "/repo", 1)).toBe("@/elsewhere/b.ts#L1")
})

test("multi-line prompts are bracketed-pasted so newlines don't submit", () => {
  expect(promptBytes("hello")).toBe("hello")
  expect(promptBytes("a\nb")).toBe("\x1b[200~a\nb\x1b[201~")
})

test("sends go to the deepest instance whose directory contains the current one", () => {
  const at = (dir: string, name = dir) => {
    const buffer = new BufferModel({ name, text: "" })
    buffer.locals.set(CLAUDE_DIRECTORY_LOCAL, dir)
    return buffer
  }
  const repo = at("/repo")
  const pkg = at("/repo/pkg")
  const pkgReview = at("/repo/pkg", "review")
  const other = at("/repo-other")
  const all = [repo, pkg, pkgReview, other]
  expect(instancesFor(all, "/repo")).toEqual([repo])
  expect(instancesFor(all, "/repo/src")).toEqual([repo])
  expect(instancesFor(all, "/repo/pkg/lib")).toEqual([pkg, pkgReview])
  expect(instancesFor(all, "/elsewhere")).toEqual([])
})

async function waitFor(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise(r => setTimeout(r, 25))
  }
}

test("claude-code runs the CLI in a jterm buffer and send-command types into it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-claude-code-"))
  dirs.push(dir)
  const fake = join(dir, "fake-claude")
  await writeFile(fake, `#!/bin/sh\necho "args:$*"\nprintf 'ready> '\nwhile read line; do echo "got:$line"; printf 'ready> '; done\n`)
  await chmod(fake, 0o755)
  await writeFile(join(dir, "a.txt"), "one\ntwo\n")

  const editor = new Editor()
  const jterm = await import(join(jemacsHome(), "plugins/jterm/index.ts")) as { install(editor: Editor): void }
  jterm.install(editor)
  install(editor)
  setCustom("claude-code-program", fake)
  setCustom("claude-code-program-switches", "--model opus")
  setCustom("claude-code-submit-delay", 10)

  const source = await editor.openFile(join(dir, "a.txt"))
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("two")
  await editor.run("claude-code")
  const [buffer] = claudeBuffers(editor)
  expect(buffer?.name).toBe(claudeBufferName(dir))
  try {
    await waitFor(() => buffer!.text.includes("ready>"))
    expect(buffer!.text).toContain("args:--model opus")

    // Claude opened in another window; go back to the file like a user would.
    expect(editor.currentBuffer).toBe(buffer!)
    editor.selectWindow(listWindowLeaves(editor.windowLayout).find(leaf => leaf.bufferId === source.id)!.id)
    await editor.run("claude-code-send-command-with-context", ["explain"])
    await waitFor(() => buffer!.text.includes("got:@a.txt#L2"))
    expect(buffer!.text).toContain("got:explain")
  } finally {
    editor.killBuffer(buffer!.id)
  }
  expect(claudeBuffers(editor)).toEqual([])
}, 20_000)
