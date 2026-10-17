import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newThreadCommands, projectAt, T3Client, threadTitle, type T3Project } from "./client"
import { readLastDirectory, resolveModelSelection, writeLastDirectory } from "./t3code"

const project = (id: string, workspaceRoot: string, deletedAt: string | null = null): T3Project =>
  ({ id, title: id, workspaceRoot, defaultModelSelection: null, deletedAt })

test("threadTitle follows the web client's 50-char truncation", () => {
  expect(threadTitle("  fix the   modeline\n")).toBe("fix the modeline")
  expect(threadTitle("")).toBe("New thread")
  expect(threadTitle("x".repeat(60))).toBe(`${"x".repeat(50)}...`)
})

test("projectAt only matches a live project rooted exactly at the directory", () => {
  const projects = [project("outer", "/w"), project("inner", "/w/app/"), project("gone", "/w/lib", "2026-01-01")]
  expect(projectAt(projects, "/w/app")?.id).toBe("inner")
  expect(projectAt(projects, "/w")?.id).toBe("outer")
  expect(projectAt(projects, "/w/app/src")).toBeUndefined()
  expect(projectAt(projects, "/w/lib")).toBeUndefined()
})

test("the last directory round-trips and is dropped once it no longer exists", () => {
  const root = mkdtempSync(join(tmpdir(), "t3code-state-"))
  const file = join(root, "nested", "state.json")
  expect(readLastDirectory(file)).toBeNull()
  writeLastDirectory(root, file)
  expect(readLastDirectory(file)).toBe(root)
  writeLastDirectory(join(root, "missing"), file)
  expect(readLastDirectory(file)).toBeNull()
  rmSync(root, { recursive: true })
})

test("resolveModelSelection prefers Claude defaults and applies overrides", () => {
  const opencode = { instanceId: "opencode", model: "x", options: [] }
  const settings = { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }, { id: "contextWindow", value: "1m" }] }
  expect(resolveModelSelection([opencode, settings], "", "")).toEqual(settings)
  expect(resolveModelSelection([null, opencode], "", "")).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5", options: [] })
  expect(resolveModelSelection([settings], "claude-sonnet-5-5", "")).toEqual({
    instanceId: "claudeAgent", model: "claude-sonnet-5-5", options: [{ id: "effort", value: "high" }],
  })
  expect(resolveModelSelection([settings], "", "max").options).toEqual([{ id: "contextWindow", value: "1m" }, { id: "effort", value: "max" }])
})

test("newThreadCommands builds a matching create/turn pair", () => {
  let n = 0
  const { threadId, create, turn } = newThreadCommands({
    projectId: "p1",
    prompt: "hello there",
    modelSelection: { instanceId: "claudeAgent", model: "m" },
    runtimeMode: "full-access",
    interactionMode: "default",
  }, new Date("2026-10-17T00:00:00Z"), () => `id${++n}`)
  expect(create).toMatchObject({ type: "thread.create", threadId, projectId: "p1", title: "hello there", branch: null, worktreePath: null })
  expect(turn).toMatchObject({
    type: "thread.turn.start",
    threadId,
    titleSeed: "hello there",
    message: { role: "user", text: "hello there", attachments: [] },
    createdAt: "2026-10-17T00:00:00.000Z",
  })
  expect(new Set([threadId, create.commandId, turn.commandId, turn.message.messageId]).size).toBe(4)
})

let server: ReturnType<typeof Bun.serve> | null = null
afterEach(() => {
  server?.stop(true)
  server = null
})

test("T3Client discovers the server and dispatches with the bearer token", async () => {
  const seen: Array<{ path: string; auth: string | null; body: any }> = []
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const auth = request.headers.get("authorization")
      seen.push({ path, auth, body: request.method === "POST" ? await request.json() : null })
      if (auth !== "Bearer secret") return Response.json({ code: "auth_invalid", reason: "missing_credential" }, { status: 401 })
      if (path === "/api/orchestration/snapshot") return Response.json({ snapshotSequence: 1, projects: [project("p1", "/w")] })
      return Response.json({ sequence: seen.length })
    },
  })
  const baseDir = mkdtempSync(join(tmpdir(), "t3code-base-"))
  mkdirSync(join(baseDir, "userdata"))
  writeFileSync(join(baseDir, "userdata", "server-runtime.json"), JSON.stringify({ origin: `http://127.0.0.1:${server.port}` }))

  const client = new T3Client({ baseDir, appPath: "/nonexistent.app", tokenFile: join(baseDir, "token.json"), token: "secret" })
  expect((await client.snapshot()).projects[0]!.id).toBe("p1")
  const { threadId } = await client.startThread({
    projectId: "p1",
    prompt: "go",
    modelSelection: { instanceId: "claudeAgent", model: "m" },
    runtimeMode: "full-access",
    interactionMode: "default",
  })
  expect(seen.slice(1).map(request => [request.path, request.body.type, request.body.threadId])).toEqual([
    ["/api/orchestration/dispatch", "thread.create", threadId],
    ["/api/orchestration/dispatch", "thread.turn.start", threadId],
  ])

  const rejected = new T3Client({ baseDir, appPath: "/nonexistent.app", tokenFile: join(baseDir, "token.json"), token: "wrong" })
  await expect(rejected.snapshot()).rejects.toThrow("401 auth_invalid: missing_credential")
  rmSync(baseDir, { recursive: true })
})

test("T3Client reports when T3 Code isn't running", async () => {
  const client = new T3Client({ baseDir: "/nonexistent", appPath: "/nonexistent.app", tokenFile: "/nonexistent/t", token: "x" })
  await expect(client.snapshot()).rejects.toThrow("T3 Code isn't running")
})
