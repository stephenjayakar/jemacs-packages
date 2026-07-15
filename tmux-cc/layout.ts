import {
  type BufferModel,
  type WindowId,
  type WindowNode,
} from "@jemacs/core"

export type TmuxLayoutNode = {
  type: "pane" | "horizontal" | "vertical"
  width: number
  height: number
  x: number
  y: number
  paneId?: string
  children: TmuxLayoutNode[]
}

export function parseTmuxLayout(value: string): TmuxLayoutNode {
  const comma = value.indexOf(",")
  const source = comma >= 0 ? value.slice(comma + 1) : value
  const [node, next] = parseNode(source, 0)
  if (next !== source.length) throw new Error(`Unexpected tmux layout data at ${next}`)
  return node
}

function parseNode(source: string, start: number): [TmuxLayoutNode, number] {
  const match = /^(\d+)x(\d+),(\d+),(\d+)/.exec(source.slice(start))
  if (!match) throw new Error(`Expected tmux layout node at ${start}`)
  const node: TmuxLayoutNode = {
    type: "pane",
    width: Number(match[1]),
    height: Number(match[2]),
    x: Number(match[3]),
    y: Number(match[4]),
    children: [],
  }
  let pos = start + match[0].length
  const marker = source[pos]
  if (marker === ",") {
    const pane = /^(\d+)/.exec(source.slice(pos + 1))
    if (!pane) throw new Error(`Expected pane id at ${pos + 1}`)
    node.paneId = `%${pane[1]}`
    return [node, pos + 1 + pane[0].length]
  }
  if (marker !== "{" && marker !== "[") return [node, pos]
  node.type = marker === "{" ? "horizontal" : "vertical"
  const end = marker === "{" ? "}" : "]"
  pos++
  while (pos < source.length && source[pos] !== end) {
    const [child, next] = parseNode(source, pos)
    node.children.push(child)
    pos = next
    if (source[pos] === ",") pos++
  }
  if (source[pos] !== end) throw new Error(`Expected ${end} at ${pos}`)
  if (!node.children.length) throw new Error(`Empty tmux layout group at ${start}`)
  return [node, pos + 1]
}

export function paneIds(node: TmuxLayoutNode): string[] {
  if (node.type === "pane") return node.paneId ? [node.paneId] : []
  return node.children.flatMap(paneIds)
}

/** Convert tmux's n-ary split representation to Jemacs's binary tree. */
export function tmuxLayoutToWindowTree(
  node: TmuxLayoutNode,
  bufferForPane: (paneId: string) => BufferModel,
  firstWindowId?: WindowId,
  windowIdForPane?: (paneId: string) => WindowId | undefined,
): WindowNode {
  if (node.type === "pane") {
    if (!node.paneId) throw new Error("tmux pane node has no id")
    const buffer = bufferForPane(node.paneId)
    return {
      kind: "leaf",
      id: windowIdForPane?.(node.paneId) ?? firstWindowId ?? crypto.randomUUID(),
      bufferId: buffer.id,
      point: buffer.point,
      startLine: 0,
      dedicated: false,
    }
  }
  return buildChildren(node, node.children, bufferForPane, firstWindowId, windowIdForPane)
}

function buildChildren(
  parent: TmuxLayoutNode,
  children: TmuxLayoutNode[],
  bufferForPane: (paneId: string) => BufferModel,
  firstWindowId?: WindowId,
  windowIdForPane?: (paneId: string) => WindowId | undefined,
): WindowNode {
  const first = children[0]!
  if (children.length === 1) return tmuxLayoutToWindowTree(first, bufferForPane, firstWindowId, windowIdForPane)
  const rest = children.slice(1)
  const firstTree = tmuxLayoutToWindowTree(first, bufferForPane, firstWindowId, windowIdForPane)
  const restTree = rest.length === 1
    ? tmuxLayoutToWindowTree(rest[0]!, bufferForPane, undefined, windowIdForPane)
    : buildChildren(parent, rest, bufferForPane, undefined, windowIdForPane)
  const total = parent.type === "horizontal"
    ? children.reduce((sum, child) => sum + child.width, 0) + children.length - 1
    : children.reduce((sum, child) => sum + child.height, 0) + children.length - 1
  const firstSize = parent.type === "horizontal" ? first.width : first.height
  return {
    kind: "split",
    direction: parent.type === "horizontal" ? "horizontal" : "vertical",
    firstRatio: Math.max(0.05, Math.min(0.95, firstSize / Math.max(1, total))),
    first: firstTree,
    second: restTree,
  }
}

export function tmuxClientExtent(
  node: TmuxLayoutNode,
  dims: (paneId: string) => { rows: number; cols: number } | undefined,
): { rows: number; cols: number } | undefined {
  if (node.type === "pane") return node.paneId ? dims(node.paneId) : undefined
  const childDims = node.children.map(child => tmuxClientExtent(child, dims))
  if (childDims.some(value => value == null)) return undefined
  const values = childDims as Array<{ rows: number; cols: number }>
  if (node.type === "horizontal") {
    return {
      rows: Math.max(...values.map(value => value.rows)),
      cols: values.reduce((sum, value) => sum + value.cols, 0) + values.length - 1,
    }
  }
  return {
    rows: values.reduce((sum, value) => sum + value.rows, 0) + values.length - 1,
    cols: Math.max(...values.map(value => value.cols)),
  }
}

type Rect = { x0: number; y0: number; x1: number; y1: number }

export function windowInDirection(
  layout: WindowNode,
  fromId: WindowId,
  direction: "left" | "right" | "up" | "down",
): WindowId | null {
  const rects = new Map<WindowId, Rect>()
  collectRects(layout, { x0: 0, y0: 0, x1: 1, y1: 1 }, rects)
  const current = rects.get(fromId)
  if (!current) return null
  const candidates: Array<{ id: string; distance: number; cross: number }> = []
  const cx = (current.x0 + current.x1) / 2
  const cy = (current.y0 + current.y1) / 2
  for (const [id, rect] of rects) {
    if (id === fromId) continue
    const rx = (rect.x0 + rect.x1) / 2
    const ry = (rect.y0 + rect.y1) / 2
    if (direction === "right" && rect.x0 >= current.x1 - 1e-9 && cy >= rect.y0 && cy <= rect.y1) {
      candidates.push({ id, distance: rect.x0 - current.x1, cross: Math.abs(ry - cy) })
    } else if (direction === "left" && rect.x1 <= current.x0 + 1e-9 && cy >= rect.y0 && cy <= rect.y1) {
      candidates.push({ id, distance: current.x0 - rect.x1, cross: Math.abs(ry - cy) })
    } else if (direction === "down" && rect.y0 >= current.y1 - 1e-9 && cx >= rect.x0 && cx <= rect.x1) {
      candidates.push({ id, distance: rect.y0 - current.y1, cross: Math.abs(rx - cx) })
    } else if (direction === "up" && rect.y1 <= current.y0 + 1e-9 && cx >= rect.x0 && cx <= rect.x1) {
      candidates.push({ id, distance: current.y0 - rect.y1, cross: Math.abs(rx - cx) })
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.cross - b.cross)
  return candidates[0]?.id ?? null
}

function collectRects(node: WindowNode, rect: Rect, out: Map<WindowId, Rect>): void {
  if (node.kind === "leaf") {
    out.set(node.id, rect)
    return
  }
  const ratio = node.firstRatio ?? 0.5
  if (node.direction === "horizontal") {
    const mid = rect.x0 + (rect.x1 - rect.x0) * ratio
    collectRects(node.first, { ...rect, x1: mid }, out)
    collectRects(node.second, { ...rect, x0: mid }, out)
  } else {
    const mid = rect.y0 + (rect.y1 - rect.y0) * ratio
    collectRects(node.first, { ...rect, y1: mid }, out)
    collectRects(node.second, { ...rect, y0: mid }, out)
  }
}
