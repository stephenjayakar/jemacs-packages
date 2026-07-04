import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

import type { Editor, BufferModel } from "@jemacs/core"
import { addHook, Keymap, defcustom, getCustom } from "@jemacs/core"
import { defineMinorMode } from "@jemacs/core/modes/minor-mode"
import { spawnProcess } from "@jemacs/core/platform/runtime"

type FindFileOp = (editor: Editor, path: string) => Promise<void>

// TODO: @jemacs/builtin-plugins — plugins/ is not part of @jemacs/core's export surface.
type ProjectileDeps = {
  compilationStart: typeof import("@jemacs/core/../../plugins/compile").compilationStart
  lastCompileCommand: typeof import("@jemacs/core/../../plugins/compile").lastCompileCommand
}

export type ProjectileOtherFileAlist = Array<[string, string[]]>

const ROOT_MARKERS_BOTTOM_UP = [
  ".git", ".hg", ".fslckout", "_FOSSIL_", ".bzr", "_darcs", ".pijul", ".sl", ".jj",
]
const ROOT_MARKERS_TOP = [
  "GTAGS", "TAGS", "configure.ac", "configure.in", "cscope.out",
]

const projectRootCache = new Map<string, string | null>()
const projectsCache = new Map<string, string[]>()

let knownProjects: string[] | null = null

export const projectileDefaultOtherFileAlist: ProjectileOtherFileAlist = [
  ["cpp", ["h", "hpp", "ipp"]],
  ["ipp", ["h", "hpp", "cpp"]],
  ["hpp", ["h", "ipp", "cpp", "cc"]],
  ["cxx", ["hxx", "ixx"]],
  ["ixx", ["cxx", "hxx"]],
  ["hxx", ["ixx", "cxx"]],
  ["c", ["h"]],
  ["m", ["h"]],
  ["mm", ["h"]],
  ["h", ["c", "cc", "cpp", "cxx", "m", "mm"]],
  ["cc", ["h", "hh", "hpp"]],
  ["hh", ["cc"]],
  ["vert", ["frag"]],
  ["frag", ["vert"]],
  ["cu", ["cuh"]],
  ["cuh", ["cu"]],
  ["ino", ["h"]],
  ["pde", ["h"]],
  ["S", ["R"]],
  ["R", ["S"]],
  ["vim", ["lua"]],
  ["lua", ["vim"]],
  ["ts", ["test.ts", "spec.ts", "tsx"]],
  ["tsx", ["test.tsx", "spec.tsx", "ts"]],
  ["js", ["test.js", "spec.js", "jsx"]],
  ["jsx", ["test.jsx", "spec.jsx", "js"]],
  ["test.ts", ["ts", "tsx"]],
  ["spec.ts", ["ts", "tsx"]],
  ["test.tsx", ["tsx", "ts"]],
  ["spec.tsx", ["tsx", "ts"]],
  ["test.js", ["js", "jsx"]],
  ["spec.js", ["js", "jsx"]],
  ["test.jsx", ["jsx", "js"]],
  ["spec.jsx", ["jsx", "js"]],
]

defcustom("projectile-known-projects-file", "string", join(homedir(), ".jemacs", "projectile-bookmarks.json"),
  "File where Projectile known project roots are persisted.")

/** Test-only: clear module caches between cases. */
export function resetProjectileStateForTests(): void {
  knownProjects = null
  projectRootCache.clear()
  projectsCache.clear()
}

function jemacsDir(): string {
  return join(homedir(), ".jemacs")
}

function knownProjectsFile(): string {
  return getCustom<string>("projectile-known-projects-file")
    ?? join(jemacsDir(), "projectile-bookmarks.json")
}

function keymapPrefix(): string {
  return getCustom<string>("projectile-keymap-prefix") ?? "C-c p"
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

async function locateDominatingFile(start: string, marker: string): Promise<string | null> {
  let dir = resolve(start)
  const root = resolve("/")
  while (dir !== root) {
    if (await pathExists(join(dir, marker))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function rootTopDown(dir: string): Promise<string | null> {
  for (const marker of ROOT_MARKERS_TOP) {
    const found = await locateDominatingFile(dir, marker)
    if (found) return found
  }
  return null
}

async function rootBottomUp(dir: string): Promise<string | null> {
  for (const marker of ROOT_MARKERS_BOTTOM_UP) {
    const found = await locateDominatingFile(dir, marker)
    if (found) return found
  }
  return null
}

async function rootMarked(dir: string): Promise<string | null> {
  return (await pathExists(join(dir, ".projectile"))) ? dir : null
}

/** `projectile-project-root` */
export async function projectileProjectRoot(dir?: string): Promise<string | null> {
  const start = resolve(dir ?? process.cwd())
  const cached = projectRootCache.get(start)
  if (cached !== undefined) return cached

  for (const fn of [rootMarked, rootTopDown, rootBottomUp]) {
    const value = await fn(start)
    if (value) {
      projectRootCache.set(start, value)
      return value
    }
  }
  projectRootCache.set(start, null)
  return null
}

export async function projectileProjectFiles(projectRoot: string): Promise<string[]> {
  const root = resolve(projectRoot)
  if (getCustom<boolean>("projectile-enable-caching")) {
    const cached = projectsCache.get(root)
    if (cached) return [...cached]
  }

  const proc = spawnProcess({ cmd: ["git", "ls-files", "-z"], cwd: root, stdout: "pipe", stderr: "pipe" })
  const out = proc.stdout ? await new Response(proc.stdout).text() : ""
  await proc.exited
  const files = out.split("\0").filter(Boolean).sort()

  if (getCustom<boolean>("projectile-enable-caching")) {
    projectsCache.set(root, files)
  }
  return files
}

function invalidateProjectCaches(root?: string): void {
  projectRootCache.clear()
  if (root) projectsCache.delete(resolve(root))
  else projectsCache.clear()
}

async function readKnownProjectsFile(): Promise<string[]> {
  const text = await readFile(knownProjectsFile(), "utf8").catch(() => null)
  if (!text) return []
  try {
    const data = JSON.parse(text) as unknown
    return Array.isArray(data) ? data.map(String).map(p => resolve(p)) : []
  } catch {
    return []
  }
}

async function saveKnownProjects(): Promise<void> {
  const file = knownProjectsFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(knownProjects ?? [], null, 2), "utf8")
}

export async function projectileKnownProjects(): Promise<string[]> {
  if (!knownProjects) knownProjects = await readKnownProjectsFile()
  return [...knownProjects]
}

export async function projectileAddKnownProject(root: string): Promise<void> {
  const dir = resolve(root)
  if (getCustom<string[]>("projectile-ignored-projects")?.includes(dir)) return
  const list = await projectileKnownProjects()
  const i = list.indexOf(dir)
  if (i === 0) return
  if (i > 0) list.splice(i, 1)
  list.unshift(dir)
  knownProjects = list
  await saveKnownProjects()
}

export async function projectileRemoveKnownProject(root: string): Promise<void> {
  const dir = resolve(root)
  knownProjects = (await projectileKnownProjects()).filter(p => p !== dir)
  await saveKnownProjects()
}

export async function projectileCleanupKnownProjects(): Promise<string[]> {
  const projects = await projectileKnownProjects()
  const kept: string[] = []
  const removed: string[] = []
  for (const project of projects) {
    if (await pathExists(project)) kept.push(project)
    else removed.push(project)
  }
  knownProjects = kept
  await saveKnownProjects()
  return removed
}

function projectileDefaultProjectName(root: string): string {
  return basename(resolve(root)) || root
}

function projectileProjectName(root: string | null): string {
  const custom = getCustom<string>("projectile-project-name")
  if (custom) return custom
  if (root) return projectileDefaultProjectName(root)
  return "-"
}

function prependProjectName(prompt: string, root: string | null): string {
  if (!root) return prompt
  return `[${projectileProjectName(root)}] ${prompt}`
}

async function projectileCompletingRead(
  editor: Editor,
  prompt: string,
  collection: string[],
  root: string | null,
  history?: string,
): Promise<string | null> {
  return editor.completingRead(prependProjectName(prompt, root), {
    collection,
    history: history ?? "projectile",
  })
}

async function startDir(editor: Editor, override?: string): Promise<string> {
  return override ?? editor.currentBuffer.directory() ?? process.cwd()
}

async function acquireRoot(editor: Editor, override?: string): Promise<string | null> {
  const start = await startDir(editor, override)
  const root = await projectileProjectRoot(start)
  if (root) return root

  const requireRoot = getCustom<boolean | "prompt">("projectile-require-project-root")
  if (requireRoot === "prompt") {
    const projects = await projectileKnownProjects()
    if (!projects.length) {
      editor.message("There are no known projects")
      return null
    }
    return projectileCompletingRead(editor, "Switch to project: ", projects, null, "projectile-project")
  }
  if (requireRoot === true) {
    editor.message(`Projectile cannot find a project definition in ${start}`)
    return null
  }
  return start
}

function maybeInvalidateCache(force: number | boolean | null | undefined, root: string): void {
  if (force != null) invalidateProjectCaches(root)
}

function allBuffers(editor: Editor): BufferModel[] {
  return [...editor.buffers.values()]
}

async function openFindFile(
  editor: Editor,
  invalidate: number | boolean | null | undefined,
  open: FindFileOp,
  override?: string,
): Promise<void> {
  const root = await acquireRoot(editor, override)
  if (!root) return
  maybeInvalidateCache(invalidate, root)
  await projectileAddKnownProject(root)
  const files = await projectileProjectFiles(root)
  if (!files.length) {
    editor.message(`No tracked files in ${root}`)
    return
  }
  const choice = await projectileCompletingRead(editor, "Find file: ", files, root, "projectile-file")
  if (!choice) return
  await open(editor, join(root, choice))
  await editor.runHook("projectile-find-file-hook", editor.currentBuffer)
}

function filenameAtPoint(buffer: BufferModel): string {
  const text = buffer.text
  const offset = buffer.point
  const re = /[\w./@~+-]+(?:\.[\w.-]+)?/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    const start = match.index
    const end = start + match[0].length
    if (offset >= start && offset <= end) return match[0]
  }
  return ""
}

function selectDwimFiles(files: string[], needle: string): string[] {
  if (!needle) return []
  const normalized = needle.replace(/^\.\//, "")
  return files.filter(f => f.includes(normalized))
}

function otherFileSuffix(suffix: string): string {
  return suffix.startsWith(".") ? suffix : `.${suffix}`
}

function splitOtherFile(path: string, fromSuffix: string): { stem: string; dir: string; base: string } | null {
  const suffix = otherFileSuffix(fromSuffix)
  if (!path.endsWith(suffix)) return null
  const stem = path.slice(0, -suffix.length)
  return { stem, dir: dirname(stem), base: basename(stem) }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

export function projectileOtherFileCandidates(
  file: string,
  projectFiles: string[],
  alist: ProjectileOtherFileAlist = projectileDefaultOtherFileAlist,
): string[] {
  const direct: string[] = []
  const basenameMatches: string[] = []
  const sortedAlist = [...alist].sort((a, b) => otherFileSuffix(b[0]).length - otherFileSuffix(a[0]).length)

  for (const [from, tos] of sortedAlist) {
    const split = splitOtherFile(file, from)
    if (!split) continue
    for (const to of tos) {
      const target = `${split.stem}${otherFileSuffix(to)}`
      if (projectFiles.includes(target) && target !== file) direct.push(target)
      const targetBase = `${split.base}${otherFileSuffix(to)}`
      for (const candidate of projectFiles) {
        if (candidate !== file && basename(candidate) === targetBase) basenameMatches.push(candidate)
      }
    }
  }

  return uniqueStrings([...direct, ...basenameMatches])
}

function projectDirs(files: string[]): string[] {
  return [...new Set(files.map(f => {
    const d = dirname(f)
    return d === "." ? "" : d + "/"
  }).filter(Boolean))].sort()
}

function projectFilesInDirectory(files: string[], directory: string): string[] {
  const normalized = directory.replace(/^\.\//, "").replace(/\/$/, "")
  if (!normalized || normalized === ".") return [...files]
  const dir = normalized + "/"
  return files.filter(f => f.startsWith(dir))
}

function projectRelativeDirectory(root: string, directory: string): string {
  if (!isAbsolute(directory)) return directory
  const resolvedRoot = resolve(root)
  const resolvedDirectory = resolve(directory)
  if (resolvedDirectory === resolvedRoot) return ""
  return resolvedDirectory.startsWith(resolvedRoot + "/")
    ? resolvedDirectory.slice(resolvedRoot.length + 1)
    : directory
}

async function recentfList(): Promise<string[] | null> {
  try {
    // TODO: @jemacs/builtin-plugins — see ProjectileDeps note above.
    const persistModule = "@jemacs/core/../../plugins/persist"
    const persist = await import(persistModule)
    return [...persist.recentfList]
  } catch {
    return null
  }
}

async function findFileDwim(
  editor: Editor,
  invalidate: number | boolean | null | undefined,
  open: FindFileOp,
  override?: string,
): Promise<void> {
  const root = await acquireRoot(editor, override)
  if (!root) return
  maybeInvalidateCache(invalidate, root)
  const files = await projectileProjectFiles(root)
  const needle = filenameAtPoint(editor.currentBuffer)
  const matches = selectDwimFiles(files, needle)
  let choice: string | null
  if (matches.length === 1) choice = matches[0]!
  else if (matches.length > 1) {
    choice = await projectileCompletingRead(editor, "Switch to: ", matches, root, "projectile-file")
  } else {
    choice = await projectileCompletingRead(editor, "Switch to: ", files, root, "projectile-file")
  }
  if (!choice) return
  await open(editor, join(root, choice))
  await editor.runHook("projectile-find-file-hook", editor.currentBuffer)
}

async function switchProjectByName(editor: Editor, project: string, commander: boolean): Promise<void> {
  const root = resolve(project)
  if (!(await projectileProjectRoot(root))) {
    knownProjects = (await projectileKnownProjects()).filter(p => p !== root)
    await saveKnownProjects()
    editor.message(`Directory ${root} is not a project`)
    return
  }
  await editor.runHook("projectile-before-switch-project-hook", editor.currentBuffer)
  const action = commander
    ? "projectile-commander"
    : (getCustom<string>("projectile-switch-project-action") ?? "projectile-find-file")
  await editor.run(action, [root])
  await editor.runHook("projectile-after-switch-project-hook", editor.currentBuffer)
}

function projectBufferFiles(editor: Editor, root: string): BufferModel[] {
  const resolved = resolve(root)
  return allBuffers(editor).filter(buf => {
    const dir = buf.directory()
    return dir != null && (dir === resolved || dir.startsWith(resolved + "/"))
  })
}

async function openProjects(editor: Editor): Promise<string[]> {
  const seen = new Set<string>()
  const out: string[] = []
  for (const buf of allBuffers(editor)) {
    const dir = buf.directory()
    if (!dir) continue
    const root = await projectileProjectRoot(dir)
    if (!root || seen.has(root)) continue
    seen.add(root)
    out.push(root)
  }
  return out
}

function testFilePredicate(file: string): boolean {
  return /(?:^|\/)(?:test|spec|tests)\/|(?:_test|\.test|\.spec)\./.test(file)
}

function implementationOrTestTarget(file: string, files: string[]): string | undefined {
  if (testFilePredicate(file)) {
    const implementation = file
      .replace(/_test(\.[^/]+)$/, "$1")
      .replace(/\.test(\.[^/]+)$/, "$1")
      .replace(/\.spec(\.[^/]+)$/, "$1")
      .replace(/\/test\//, "/")
    return files.find(f => f === implementation)
  }

  const base = basename(file)
  const dir = dirname(file)
  const stem = base.replace(/\.[^.]+$/, "")
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")) : ""
  const candidates = [
    join(dir, `${stem}_test${ext}`),
    join(dir, `${stem}.test${ext}`),
    join(dir, `${stem}.spec${ext}`),
    file.replace(/(^|\/)(src|lib)\//, "$1test/"),
    file.replace(/(^|\/)(src|lib)\//, "$1tests/"),
  ]
  return uniqueStrings(candidates).find(candidate => files.includes(candidate))
}

const PROJECTILE_COMMAND_MAP: Array<[string, string]> = [
  ["4 a", "projectile-find-other-file-other-window"],
  ["4 b", "projectile-switch-to-buffer-other-window"],
  ["4 f", "projectile-find-file-other-window"],
  ["4 g", "projectile-find-file-dwim-other-window"],
  ["4 t", "projectile-find-implementation-or-test-other-window"],
  ["5 f", "projectile-find-file-other-frame"],
  ["5 g", "projectile-find-file-dwim-other-frame"],
  ["!", "projectile-run-shell-command-in-root"],
  ["?", "projectile-find-references"],
  ["a", "projectile-find-other-file"],
  ["A", "projectile-add-known-project"],
  ["b", "projectile-switch-to-buffer"],
  ["d", "projectile-find-dir"],
  ["D", "projectile-dired"],
  ["e", "projectile-recentf"],
  ["C-f", "projectile-find-file-in-directory"],
  ["g", "projectile-find-file-dwim"],
  ["F", "projectile-find-file-in-known-projects"],
  ["f", "projectile-find-file"],
  ["i", "projectile-invalidate-cache"],
  ["I", "projectile-ibuffer"],
  ["k", "projectile-kill-buffers"],
  ["p", "projectile-switch-project"],
  ["q", "projectile-switch-open-project"],
  ["r", "projectile-replace"],
  ["s g", "projectile-grep"],
  ["s s", "projectile-ag"],
  ["t", "projectile-toggle-between-implementation-and-test"],
  ["T", "projectile-find-test-file"],
  ["v", "projectile-vc"],
  ["z", "projectile-cache-current-file"],
  ["c c", "projectile-compile-project"],
  ["c t", "projectile-test-project"],
  ["c r", "projectile-run-project"],
]

export const PROJECTILE_COMMANDER_COMMANDS: Record<string, { command: string; label: string }> = {
  f: { command: "projectile-find-file", label: "find-file" },
  b: { command: "projectile-switch-to-buffer", label: "switch-to-buffer" },
  d: { command: "projectile-find-dir", label: "find-dir" },
  s: { command: "projectile-grep", label: "grep/search" },
  r: { command: "projectile-replace", label: "replace" },
  T: { command: "projectile-test-project", label: "test-project" },
  c: { command: "projectile-compile-project", label: "compile-project" },
}

function projectileCommanderHelp(): string {
  return Object.entries(PROJECTILE_COMMANDER_COMMANDS)
    .map(([key, { label }]) => `${key}: ${label}`)
    .join(", ")
}

function bytesContainNul(bytes: Uint8Array): boolean {
  return bytes.includes(0)
}

export async function install(editor: Editor, deps?: ProjectileDeps): Promise<void> {
  defcustom("projectile-enable-caching", "boolean", true,
    "When t enables project files caching for the session.")
  defcustom("projectile-keymap-prefix", "string", "C-c p",
    "Projectile keymap prefix (Stephen: C-c p).")
  defcustom("projectile-switch-project-action", "string", "projectile-find-file",
    "Command invoked after switching projects.")
  defcustom("projectile-require-project-root", "sexp", false,
    "nil, t, or prompt — whether a project root is required.")
  defcustom("projectile-ignored-projects", "sexp", [],
    "Projects not added to projectile-known-projects.")
  defcustom("projectile-track-known-projects-automatically", "boolean", true,
    "Register projects when visiting files.")
  defcustom("projectile-other-file-alist", "sexp", projectileDefaultOtherFileAlist,
    "Alist mapping file suffixes to related file suffixes.")

  const projectileMap = new Keymap("projectile-command-map")
  const defaultOpen: FindFileOp = async (ed, path) => { await ed.openFile(path) }
  const otherWindowOpen: FindFileOp = async (ed, path) => { await ed.run("find-file-other-window", [path]) }

  const requireCompile = (ed: Editor): ProjectileDeps | null => {
    if (deps) return deps
    ed.message("projectile: compile plugin not wired (pass deps to install)")
    return null
  }

  editor.command("projectile-project-root", async ({ editor, args }) => {
    const root = await projectileProjectRoot(args[0] ?? await startDir(editor))
    if (root) editor.message(root)
    return root
  }, "Echo the root directory of the current project.")

  editor.command("projectile-find-file", async ({ editor, args, prefixArgument }) => {
    await openFindFile(editor, prefixArgument, defaultOpen, args[0])
  }, "Jump to a project's file using completion.")

  editor.command("projectile-find-file-other-window", async ({ editor, args, prefixArgument }) => {
    await openFindFile(editor, prefixArgument, otherWindowOpen, args[0])
  }, "Jump to a project file in another window.")

  editor.command("projectile-find-file-other-frame", async ({ editor, args, prefixArgument }) => {
    await openFindFile(editor, prefixArgument, defaultOpen, args[0])
  }, "Jump to a project file (no separate frame in Jemacs).")

  editor.command("projectile-find-file-dwim", async ({ editor, args, prefixArgument }) => {
    await findFileDwim(editor, prefixArgument, defaultOpen, args[0])
  }, "Jump to a project file using completion based on context.")

  editor.command("projectile-find-file-dwim-other-window", async ({ editor, args, prefixArgument }) => {
    await findFileDwim(editor, prefixArgument, otherWindowOpen, args[0])
  }, "DWIM find-file in another window.")

  editor.command("projectile-switch-project", async ({ editor, prefixArgument }) => {
    const projects = await projectileKnownProjects()
    if (!projects.length) {
      editor.message("There are no known projects")
      return
    }
    const root = await projectileCompletingRead(editor, "Switch to project: ", projects, null, "projectile-project")
    if (!root) return
    await switchProjectByName(editor, root, prefixArgument != null)
  }, "Switch to a known project.")

  editor.command("projectile-switch-open-project", async ({ editor, prefixArgument }) => {
    const projects = await openProjects(editor)
    if (!projects.length) {
      editor.message("There are no open projects")
      return
    }
    const root = await projectileCompletingRead(editor, "Switch to open project: ", projects, null, "projectile-project")
    if (!root) return
    await switchProjectByName(editor, root, prefixArgument != null)
  }, "Switch to an open project.")

  editor.command("projectile-invalidate-cache", async ({ editor, prefixArgument }) => {
    invalidateProjectCaches()
    if (prefixArgument != null) {
      const roots = [...projectsCache.keys()]
      const root = await editor.completingRead("Remove cache for: ", { collection: roots })
      if (root) invalidateProjectCaches(String(root))
    } else {
      const root = await projectileProjectRoot(await startDir(editor))
      if (root) invalidateProjectCaches(root)
    }
    editor.message("Invalidated Projectile cache.")
  }, "Remove the current project's files from cache.")

  editor.command("projectile-dired", async ({ editor, prefixArgument }) => {
    let root: string | null
    if (prefixArgument != null) {
      const projects = await projectileKnownProjects()
      root = await projectileCompletingRead(editor, "Dired in project: ", projects, null, "projectile-project")
    } else {
      root = await acquireRoot(editor)
    }
    if (!root) return
    await editor.run("dired", [root])
  }, "Open dired at the project root.")

  editor.command("projectile-compile-project", async ({ editor, args, prefixArgument }) => {
    const compile = requireCompile(editor)
    if (!compile) return
    const firstArgIsRoot = args[0] != null && await projectileProjectRoot(args[0]) === resolve(args[0])
    const root = await acquireRoot(editor, firstArgIsRoot ? args[0] : undefined)
    if (!root) return
    const cmd = (firstArgIsRoot ? args[1] : args[0])
      ?? (prefixArgument != null
        ? await editor.prompt("Compile command: ", compile.lastCompileCommand(editor), "compile-command")
        : compile.lastCompileCommand(editor))
    if (!cmd) return
    await compile.compilationStart(editor, cmd, root)
  }, "Compile the current project.")

  editor.command("projectile-grep", async ({ editor, args }) => {
    const firstArgIsRoot = args[0] != null && await projectileProjectRoot(args[0]) === resolve(args[0])
    const root = await acquireRoot(editor, firstArgIsRoot ? args[0] : undefined)
    if (!root) return
    const pattern = (firstArgIsRoot ? args[1] : args[0]) ?? await editor.prompt(prependProjectName("Grep for: ", root), "", "search")
    if (!pattern) return
    await editor.run("counsel-ag", [pattern])
  }, "Grep the project.")

  editor.command("projectile-ag", async ({ editor, args, prefixArgument }) => {
    const root = await acquireRoot(editor)
    if (!root) return
    const label = prefixArgument != null ? "Ag regexp search for: " : "Ag search for: "
    const pattern = args[0] ?? await editor.prompt(prependProjectName(label, root), "", "search")
    if (!pattern) return
    await editor.run("counsel-ag", [pattern])
  }, "Search the project with ripgrep.")

  editor.command("projectile-recentf", async ({ editor }) => {
    const root = await acquireRoot(editor)
    if (!root) return
    const list = await recentfList()
    if (!list) {
      editor.message("projectile-recentf: recentf plugin is not available; falling back to recentf-open")
      await editor.run("recentf-open")
      return
    }
    const resolvedRoot = resolve(root)
    const files = list.filter(f => {
      const path = resolve(f)
      return path === resolvedRoot || path.startsWith(resolvedRoot + "/")
    })
    if (!files.length) {
      editor.message("No recent files in current project")
      return
    }
    const choice = await projectileCompletingRead(editor, "Open recent file: ", files, root, "file")
    if (choice) await editor.openFile(choice)
  }, "Open a recent file from the current project.")

  editor.command("projectile-add-known-project", async ({ editor, args }) => {
    const root = args[0] ?? await editor.prompt("Add to known projects: ", editor.currentBuffer.directory() ?? process.cwd())
    if (!root) return
    await projectileAddKnownProject(root)
    editor.message(`Added ${resolve(root)} to known projects`)
  }, "Add a directory to known projects.")

  editor.command("projectile-remove-known-project", async ({ editor, args }) => {
    const projects = await projectileKnownProjects()
    if (!projects.length) {
      editor.message("There are no known projects")
      return
    }
    const root = args[0] ?? await projectileCompletingRead(editor, "Remove known project: ", projects, null, "projectile-project")
    if (!root) return
    await projectileRemoveKnownProject(root)
    editor.message(`Removed ${resolve(root)} from known projects`)
  }, "Remove a project from Projectile's known projects.")

  editor.command("projectile-cleanup-known-projects", async ({ editor }) => {
    const removed = await projectileCleanupKnownProjects()
    editor.message(`Removed ${removed.length} missing project${removed.length === 1 ? "" : "s"}`)
  }, "Remove missing directories from Projectile's known projects.")

  editor.command("projectile-switch-to-buffer", async ({ editor, args }) => {
    const root = await acquireRoot(editor, args[0])
    if (!root) return
    const names = projectBufferFiles(editor, root).map(b => b.name)
    const choice = await projectileCompletingRead(editor, "Switch to buffer: ", names, root, "projectile-buffer")
    if (!choice) return
    editor.switchToBuffer(choice)
  }, "Switch to a buffer in the current project.")

  editor.command("projectile-switch-to-buffer-other-window", async ({ editor }) => {
    const root = await acquireRoot(editor)
    if (!root) return
    const names = projectBufferFiles(editor, root).map(b => b.name)
    const choice = await projectileCompletingRead(editor, "Switch to buffer: ", names, root, "projectile-buffer")
    if (!choice) return
    await editor.run("switch-to-buffer-other-window", [choice])
  }, "Switch to a project buffer in another window.")

  editor.command("projectile-ibuffer", async ({ editor }) => {
    const root = await acquireRoot(editor)
    if (!root) return
    const buffers = projectBufferFiles(editor, root)
    if (!buffers.length) {
      editor.message("No project buffers")
      return
    }
    const names = buffers.map(b => editor.bufferDisplayName(b))
    const choice = await projectileCompletingRead(editor, "Project buffer: ", names, root, "projectile-buffer")
    if (!choice) return
    editor.switchToBuffer(choice)
  }, "Select a project buffer (Jemacs has no native ibuffer UI).")

  editor.command("projectile-kill-buffers", async ({ editor }) => {
    const root = await acquireRoot(editor)
    if (!root) return
    const buffers = projectBufferFiles(editor, root).filter(b => b.path)
    for (const buf of buffers) editor.killBuffer(buf.name)
    editor.message(`Killed ${buffers.length} project buffers`)
  }, "Kill project file buffers.")

  editor.command("projectile-find-dir", async ({ editor, args, prefixArgument }) => {
    const root = await acquireRoot(editor, args[0])
    if (!root) return
    maybeInvalidateCache(prefixArgument, root)
    const files = await projectileProjectFiles(root)
    const dirs = projectDirs(files)
    const choice = await projectileCompletingRead(editor, "Find directory: ", dirs, root, "projectile-dir")
    if (!choice) return
    await editor.run("dired", [join(root, choice)])
  }, "Jump to a project directory.")

  editor.command("projectile-find-file-in-directory", async ({ editor, args, prefixArgument }) => {
    const root = await acquireRoot(editor)
    if (!root) return
    maybeInvalidateCache(prefixArgument, root)
    const files = await projectileProjectFiles(root)
    const dirs = projectDirs(files)
    const directory = args[0]
      ?? await projectileCompletingRead(editor, "Find file in directory: ", dirs, root, "projectile-dir")
    if (!directory) return
    const relDir = projectRelativeDirectory(root, directory)
    const choices = projectFilesInDirectory(files, relDir)
    if (!choices.length) {
      editor.message(`No tracked files in ${directory}`)
      return
    }
    const choice = await projectileCompletingRead(editor, "Find file: ", choices, root, "projectile-file")
    if (choice) await editor.openFile(join(root, choice))
  }, "Find a project file under a selected project directory.")

  editor.command("projectile-find-test-file", async ({ editor, prefixArgument }) => {
    const root = await acquireRoot(editor)
    if (!root) return
    maybeInvalidateCache(prefixArgument, root)
    const files = (await projectileProjectFiles(root)).filter(testFilePredicate)
    const choice = await projectileCompletingRead(editor, "Find test file: ", files, root, "projectile-file")
    if (!choice) return
    await editor.openFile(join(root, choice))
  }, "Jump to a test file in the project.")

  editor.command("projectile-toggle-between-implementation-and-test", async ({ editor }) => {
    const path = editor.currentBuffer.path
    const root = path ? await projectileProjectRoot(dirname(path)) : null
    if (!path || !root) {
      editor.message("Not in a project file")
      return
    }
    const rel = path.startsWith(root) ? path.slice(root.length + 1) : basename(path)
    const files = await projectileProjectFiles(root)
    const target = implementationOrTestTarget(rel, files)
    if (!target) {
      editor.message("No matching implementation/test file found")
      return
    }
    await editor.openFile(join(root, target))
  }, "Toggle between implementation and test file.")

  editor.command("projectile-find-other-file", async ({ editor, prefixArgument }) => {
    const path = editor.currentBuffer.path
    const root = path ? await projectileProjectRoot(dirname(path)) : null
    if (!path || !root) {
      editor.message("Not in a project file")
      return
    }
    maybeInvalidateCache(prefixArgument, root)
    const rel = path.startsWith(root) ? path.slice(root.length + 1) : basename(path)
    const files = await projectileProjectFiles(root)
    const alist = getCustom<ProjectileOtherFileAlist>("projectile-other-file-alist")
      ?? projectileDefaultOtherFileAlist
    const candidates = projectileOtherFileCandidates(rel, files, alist)
    if (!candidates.length) {
      editor.message("No matching other file found")
      return
    }
    const choice = candidates.length === 1
      ? candidates[0]!
      : await projectileCompletingRead(editor, "Find other file: ", candidates, root, "projectile-file")
    if (choice) await editor.openFile(join(root, choice))
  }, "Switch between files with the same basename and different extensions.")

  editor.command("projectile-find-other-file-other-window", async ({ editor, prefixArgument }) => {
    const path = editor.currentBuffer.path
    const root = path ? await projectileProjectRoot(dirname(path)) : null
    if (!path || !root) {
      editor.message("Not in a project file")
      return
    }
    maybeInvalidateCache(prefixArgument, root)
    const rel = path.startsWith(root) ? path.slice(root.length + 1) : basename(path)
    const files = await projectileProjectFiles(root)
    const alist = getCustom<ProjectileOtherFileAlist>("projectile-other-file-alist")
      ?? projectileDefaultOtherFileAlist
    const candidates = projectileOtherFileCandidates(rel, files, alist)
    if (!candidates.length) {
      editor.message("No matching other file found")
      return
    }
    const choice = candidates.length === 1
      ? candidates[0]!
      : await projectileCompletingRead(editor, "Find other file: ", candidates, root, "projectile-file")
    if (choice) await editor.run("find-file-other-window", [join(root, choice)])
  })

  editor.command("projectile-find-implementation-or-test-other-window", async ({ editor }) => {
    const path = editor.currentBuffer.path
    const root = path ? await projectileProjectRoot(dirname(path)) : null
    if (!path || !root) {
      editor.message("Not in a project file")
      return
    }
    const rel = path.startsWith(root) ? path.slice(root.length + 1) : basename(path)
    const files = await projectileProjectFiles(root)
    const target = implementationOrTestTarget(rel, files)
    if (!target) {
      editor.message("No matching implementation/test file found")
      return
    }
    await editor.run("find-file-other-window", [join(root, target)])
  })

  editor.command("projectile-find-file-in-known-projects", async ({ editor }) => {
    const projects = await projectileKnownProjects()
    const all: string[] = []
    for (const p of projects) {
      const files = await projectileProjectFiles(p)
      for (const f of files) all.push(join(p, f))
    }
    const choice = await editor.completingRead("Find file: ", { collection: all, history: "projectile-file" })
    if (choice) await editor.openFile(choice)
  }, "Find a file across all known projects.")

  editor.command("projectile-cache-current-file", async ({ editor }) => {
    const path = editor.currentBuffer.path
    const root = path ? await projectileProjectRoot(dirname(path)) : null
    if (!path || !root || !getCustom<boolean>("projectile-enable-caching")) return
    const rel = path.startsWith(root) ? path.slice(root.length + 1) : null
    if (!rel) return
    const cached = projectsCache.get(root) ?? []
    if (!cached.includes(rel)) {
      projectsCache.set(root, [rel, ...cached])
      editor.message(`File ${rel} added to project cache`)
    }
  }, "Add the current file to the project cache.")

  editor.command("projectile-replace", async ({ editor, args }) => {
    const firstArgIsRoot = args[0] != null && await projectileProjectRoot(args[0]) === resolve(args[0])
    const root = await acquireRoot(editor, firstArgIsRoot ? args[0] : undefined)
    if (!root) return
    const from = (firstArgIsRoot ? args[1] : args[0]) ?? await editor.prompt(prependProjectName("Query replace: ", root), "", "query-replace")
    if (!from) return
    const to = (firstArgIsRoot ? args[2] : args[1]) ?? await editor.prompt(`Replace ${from} with: `, "", "query-replace")
    if (to == null) return
    let visited = 0
    for (const file of await projectileProjectFiles(root)) {
      const path = join(root, file)
      const bytes = await readFile(path).catch(() => null)
      if (!bytes || bytesContainNul(bytes) || !bytes.toString("utf8").includes(from)) continue
      const buffer = await editor.openFile(path)
      buffer.point = 0
      visited++
      await editor.run("query-replace", [from, to])
    }
    editor.message(`Query replace visited ${visited} file${visited === 1 ? "" : "s"}`)
  }, "Replace in project files.")

  editor.command("projectile-find-references", async ({ editor }) => {
    await editor.run("xref-find-references")
  }, "Find references in the project.")

  editor.command("projectile-vc", async ({ editor }) => {
    const root = await acquireRoot(editor)
    if (!root) return
    editor.message("projectile-vc: Jemacs has no vc-dir integration; opening project root in dired")
    await editor.run("dired", [root])
  }, "Open version control at project root.")

  editor.command("projectile-run-shell-command-in-root", async ({ editor, args }) => {
    const compile = requireCompile(editor)
    if (!compile) return
    const root = await acquireRoot(editor)
    if (!root) return
    const cmd = args[0] ?? await editor.prompt(prependProjectName("Run command: ", root), "", "shell-command")
    if (!cmd) return
    await compile.compilationStart(editor, cmd, root)
  }, "Run a shell command at the project root.")

  editor.command("projectile-test-project", async ({ editor, args, prefixArgument }) => {
    const compile = requireCompile(editor)
    if (!compile) return
    const firstArgIsRoot = args[0] != null && await projectileProjectRoot(args[0]) === resolve(args[0])
    const root = await acquireRoot(editor, firstArgIsRoot ? args[0] : undefined)
    if (!root) return
    const cmd = (firstArgIsRoot ? args[1] : args[0]) ?? (prefixArgument != null ? await editor.prompt("Test command: ", "bun test", "compile-command") : "bun test")
    await compile.compilationStart(editor, cmd, root)
  }, "Run the project test command.")

  editor.command("projectile-run-project", async ({ editor, args }) => {
    const compile = requireCompile(editor)
    if (!compile) return
    const root = await acquireRoot(editor)
    if (!root) return
    const cmd = args[0] ?? await editor.prompt("Run command: ", "", "compile-command")
    if (!cmd) return
    await compile.compilationStart(editor, cmd, root)
  }, "Run the project.")

  editor.command("projectile-commander", async ({ editor, args }) => {
    const first = args[0]
    const firstIsKey = first != null && (first === "?" || Object.prototype.hasOwnProperty.call(PROJECTILE_COMMANDER_COMMANDS, first))
    const root = firstIsKey ? undefined : first
    const input = firstIsKey ? first : (args[1] ?? await editor.prompt("Projectile command (? for help): ", "", "projectile-commander"))
    const key = input?.slice(0, 1)
    if (!key) return
    if (key === "?") {
      editor.message(projectileCommanderHelp())
      return
    }
    const command = PROJECTILE_COMMANDER_COMMANDS[key]?.command
    if (!command) {
      editor.message(`Unknown Projectile command ${key}; ?: help`)
      return
    }
    await editor.run(command, root ? [root] : [])
  }, "Read one key and run a Projectile command.")

  const prefix = keymapPrefix()
  for (const [suffix, command] of PROJECTILE_COMMAND_MAP) {
    projectileMap.bind(`${prefix} ${suffix}`, command)
  }

  defineMinorMode({
    name: "projectile-mode",
    lighter: " Projectile",
    global: true,
    keymap: projectileMap,
  })

  addHook("find-file-hook", async ({ editor, buffer }) => {
    if (!editor.isMinorModeEnabled("projectile-mode")) return
    const path = buffer.path
    if (!path) return
    const root = await projectileProjectRoot(dirname(path))
    if (!root) return
    if (getCustom<boolean>("projectile-track-known-projects-automatically")) {
      await projectileAddKnownProject(root)
    }
    if (getCustom<boolean>("projectile-enable-caching") && projectsCache.has(root)) {
      const rel = path.startsWith(root) ? path.slice(root.length + 1) : null
      if (rel && !projectsCache.get(root)!.includes(rel)) {
        projectsCache.set(root, [rel, ...projectsCache.get(root)!])
      }
    }
  })

  editor.enableMinorMode("projectile-mode")
}
