import type { TextSpan } from "../../jemacs-opentui/src/modes/mode"

export type FileTreeNode = {
  name: string
  relPath: string
  isDirectory: boolean
  children: FileTreeNode[]
}

export type SidebarLine = {
  relPath: string
  isDirectory: boolean
  depth: number
  lineStart: number
  lineEnd: number
}

export type RenderedSidebar = {
  text: string
  lines: SidebarLine[]
}

export function buildFileTree(files: string[]): FileTreeNode {
  const root: FileTreeNode = { name: "", relPath: "", isDirectory: true, children: [] }
  for (const file of [...files].sort((a, b) => a.localeCompare(b))) {
    const parts = file.split("/").filter(Boolean)
    let node = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      const isLast = i === parts.length - 1
      const relPath = parts.slice(0, i + 1).join("/")
      let child = node.children.find(c => c.name === part)
      if (!child) {
        child = { name: part, relPath, isDirectory: !isLast, children: [] }
        node.children.push(child)
      } else if (!isLast) {
        child.isDirectory = true
      }
      node = child
    }
  }
  sortTreeChildren(root)
  return root
}

function sortTreeChildren(node: FileTreeNode): void {
  node.children.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const child of node.children) sortTreeChildren(child)
}

export function defaultExpandedPaths(tree: FileTreeNode, highlightRel?: string): Set<string> {
  const expanded = new Set<string>()
  for (const child of tree.children) {
    if (child.isDirectory) expanded.add(child.relPath)
  }
  if (highlightRel) {
    const parts = highlightRel.split("/")
    for (let i = 1; i < parts.length; i++) {
      expanded.add(parts.slice(0, i).join("/"))
    }
  }
  return expanded
}

export function renderFileTree(
  tree: FileTreeNode,
  expanded: Set<string>,
  options: { projectLabel?: string; highlightRel?: string } = {},
): RenderedSidebar {
  const chunks: string[] = []
  const lines: SidebarLine[] = []
  let offset = 0

  const pushLine = (text: string, meta: Omit<SidebarLine, "lineStart" | "lineEnd">) => {
    const lineStart = offset
    chunks.push(text)
    offset += text.length
    const lineEnd = offset
    lines.push({ ...meta, lineStart, lineEnd })
    chunks.push("\n")
    offset += 1
  }

  if (options.projectLabel) {
    pushLine(`── ${options.projectLabel} ──`, { relPath: "", isDirectory: false, depth: 0 })
  }

  const walk = (node: FileTreeNode, depth: number) => {
    if (node.relPath === "") {
      for (const child of node.children) walk(child, 0)
      return
    }
    const chevron = node.isDirectory
      ? expanded.has(node.relPath) ? "▾ " : "▸ "
      : "  "
    const indent = "  ".repeat(depth)
    const suffix = node.isDirectory ? "/" : ""
    pushLine(`${indent}${chevron}${node.name}${suffix}`, {
      relPath: node.relPath,
      isDirectory: node.isDirectory,
      depth,
    })
    if (node.isDirectory && expanded.has(node.relPath)) {
      for (const child of node.children) walk(child, depth + 1)
    }
  }

  walk(tree, 0)
  return { text: chunks.join(""), lines }
}

export function sidebarLineAtPoint(lines: SidebarLine[], point: number): SidebarLine | undefined {
  return lines.find(line => point >= line.lineStart && point < line.lineEnd + 1)
}

export function sidebarFontLock(
  text: string,
  lines: SidebarLine[],
  options: { highlightRel?: string; point: number } = { point: 0 },
): TextSpan[] {
  const spans: TextSpan[] = []
  for (const line of lines) {
    const chevronEnd = line.lineStart + 2 + line.depth * 2
    if (chevronEnd > line.lineStart) {
      spans.push({ start: line.lineStart + line.depth * 2, end: chevronEnd, face: "constant" })
    }
    if (line.isDirectory) {
      spans.push({ start: chevronEnd, end: line.lineEnd, face: "directory" })
    }
    if (options.highlightRel && line.relPath === options.highlightRel) {
      spans.push({ start: line.lineStart, end: line.lineEnd, face: "lazyHighlight" })
    }
    if (options.point >= line.lineStart && options.point < line.lineEnd + 1) {
      spans.push({ start: line.lineStart, end: line.lineEnd, face: "region" })
    }
  }
  if (text.startsWith("──")) {
    spans.push({ start: 0, end: text.indexOf("\n") || text.length, face: "title" })
  }
  return spans
}
