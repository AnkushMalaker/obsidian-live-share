import { Notice, type Vault } from "obsidian";
import * as Y from "yjs";

import type { SyncManager } from "../sync/sync";
import {
  VAULT_EVENT_SETTLE_MS,
  ensureFolder,
  getFileByPath,
  normalizePath,
  toCanonicalPath,
  toLocalPath,
} from "../utils";
import type { CanvasWritePreparation } from "./canvas-workspace";
import type { FileOpsManager } from "./file-ops";

const CANVAS_DOC_PREFIX = "__canvas__:";
const DEBOUNCE_MS = 1000;

interface CanvasData {
  nodes: Record<string, Record<string, unknown>>;
  edges: Record<string, Record<string, unknown>>;
  properties: Record<string, unknown>;
  nodeOrder: string[];
  edgeOrder: string[];
}

function emptyCanvas(): CanvasData {
  return {
    nodes: Object.create(null),
    edges: Object.create(null),
    properties: {},
    nodeOrder: [],
    edgeOrder: [],
  };
}

function parseCanvas(content: string): CanvasData | null {
  try {
    if (!content.trim()) return emptyCanvas();
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const { nodes = [], edges = [], ...properties } = parsed;
    if (!Array.isArray(nodes) || !Array.isArray(edges)) return null;
    const data: CanvasData = { ...emptyCanvas(), properties };
    for (const node of nodes) {
      if (!node || typeof node.id !== "string") return null;
      if (Object.prototype.hasOwnProperty.call(data.nodes, node.id)) return null;
      data.nodes[node.id] = node;
      data.nodeOrder.push(node.id);
    }
    for (const edge of edges) {
      if (!edge || typeof edge.id !== "string") return null;
      if (Object.prototype.hasOwnProperty.call(data.edges, edge.id)) return null;
      data.edges[edge.id] = edge;
      data.edgeOrder.push(edge.id);
    }
    return data;
  } catch {
    // Partial/invalid saves must not become a request to delete every card.
    return null;
  }
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => equal(value, b[index]))
    );
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.prototype.hasOwnProperty.call(right, key) && equal(left[key], right[key]),
    )
  );
}

function applyProperties(
  map: Y.Map<unknown>,
  next: Record<string, unknown>,
  previous: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(next)) {
    if (!equal(value, previous[key]) && !equal(value, map.get(key))) map.set(key, value);
  }
  for (const key of Object.keys(previous)) {
    if (!(key in next)) map.delete(key);
  }
}

function applyItems(
  map: Y.Map<Y.Map<unknown>>,
  next: Record<string, Record<string, unknown>>,
  previous: Record<string, Record<string, unknown>>,
): void {
  for (const [id, item] of Object.entries(next)) {
    if (equal(item, previous[id])) continue;
    let shared = map.get(id);
    if (!shared) {
      // A remote deletion wins over a stale edit of an existing card.
      if (previous[id]) continue;
      shared = new Y.Map<unknown>();
      map.set(id, shared);
    }
    applyProperties(shared, item, previous[id] ?? {});
  }
  for (const id of Object.keys(previous)) {
    if (!(id in next)) map.delete(id);
  }
}

function applyOrder(order: Y.Map<number>, next: string[], previous: string[]): void {
  const oldPositions = new Map(previous.map((id, index) => [id, index]));
  const nextIds = new Set(next);
  for (const [index, id] of next.entries()) {
    if (oldPositions.get(id) !== index || !order.has(id)) order.set(id, index);
  }
  for (const id of previous) {
    if (!nextIds.has(id)) order.delete(id);
  }
}

function orderedItems(items: Y.Map<Y.Map<unknown>>, order: Y.Map<number>): unknown[] {
  return [...items.entries()]
    .sort(
      ([a], [b]) =>
        (order.get(a) ?? Number.POSITIVE_INFINITY) - (order.get(b) ?? Number.POSITIVE_INFINITY) ||
        (a < b ? -1 : a > b ? 1 : 0),
    )
    .map(([, item]) => item.toJSON());
}

export class CanvasSync {
  private subscriptions = new Map<string, object>();
  private roles = new Map<string, "host" | "guest">();
  private subscribing = new Map<string, Promise<void>>();
  private observers = new Map<string, () => void>();
  private writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private writeQueues = new Map<string, Promise<void>>();
  private lastLocalData = new Map<string, CanvasData>();
  private localReads = new Map<string, object>();
  private flushingLocalViews = new Set<string>();

  constructor(
    private vault: Vault,
    private syncManager: SyncManager,
    private fileOpsManager: FileOpsManager,
    private localViews?: CanvasWritePreparation,
  ) {}

  async subscribe(
    rawPath: string,
    role: "host" | "guest",
    source: "local" | "remote" = "local",
  ): Promise<void> {
    const path = toCanonicalPath(normalizePath(rawPath));
    const pending = this.subscribing.get(path);
    if (pending) return pending;
    if (this.observers.has(path)) return;
    const subscription = {};
    this.subscriptions.set(path, subscription);
    this.roles.set(path, role);
    const task = this.subscribePath(path, role, subscription, source);
    this.subscribing.set(path, task);
    try {
      await task;
    } finally {
      if (this.subscribing.get(path) === task) this.subscribing.delete(path);
    }
  }

  private async subscribePath(
    path: string,
    role: "host" | "guest",
    subscription: object,
    source: "local" | "remote",
  ) {
    const docId = `${CANVAS_DOC_PREFIX}${path}`;
    const handle = this.syncManager.getDoc(docId);
    if (!handle) {
      this.subscriptions.delete(path);
      this.roles.delete(path);
      return;
    }
    try {
      await this.syncManager.waitForSync(docId);
    } catch {
      if (this.subscriptions.get(path) === subscription) this.unsubscribe(path);
      return;
    }
    if (this.subscriptions.get(path) !== subscription) return;

    const nodes = handle.doc.getMap<Y.Map<unknown>>("nodes");
    const edges = handle.doc.getMap<Y.Map<unknown>>("edges");
    const properties = handle.doc.getMap<unknown>("properties");
    const meta = handle.doc.getMap("meta");
    // Observe before asynchronous hydration so an update during that write is
    // not stranded in Yjs while disk keeps the older snapshot.
    const observer = (_events: unknown, transaction: Y.Transaction) => {
      if (transaction.origin === this) return;
      this.scheduleDiskWrite(path, subscription);
    };
    nodes.observeDeep(observer);
    edges.observeDeep(observer);
    properties.observeDeep(observer);
    handle.doc.getMap("nodeOrder").observe(observer);
    handle.doc.getMap("edgeOrder").observe(observer);
    meta.observe(observer);
    this.observers.set(path, () => {
      nodes.unobserveDeep(observer);
      edges.unobserveDeep(observer);
      properties.unobserveDeep(observer);
      handle.doc.getMap("nodeOrder").unobserve(observer);
      handle.doc.getMap("edgeOrder").unobserve(observer);
      meta.unobserve(observer);
    });

    if (role === "host" && source === "local") {
      const file = getFileByPath(this.vault, toLocalPath(path));
      const data = file ? parseCanvas(await this.vault.read(file)) : null;
      if (this.subscriptions.get(path) !== subscription) return;
      if (data) {
        // A fresh host instance follows the existing host-authoritative policy.
        // meta.seeded alone cannot tell whether a peer's retained board is stale.
        const previous = parseCanvas(this.serialize(handle.doc)) ?? emptyCanvas();
        this.applyLocalData(path, data, previous);
        this.lastLocalData.set(path, data);
        handle.doc.transact(() => meta.set("seeded", true), this);
        return;
      }
      if (file) return; // Preserve a malformed local file for recovery.
    }
    if (meta.get("seeded") || nodes.size > 0 || edges.size > 0) {
      await this.writeToDisk(path, subscription);
    }
  }

  unsubscribe(rawPath: string): void {
    const path = toCanonicalPath(normalizePath(rawPath));
    this.subscriptions.delete(path);
    this.roles.delete(path);
    this.subscribing.delete(path);
    const timer = this.writeTimers.get(path);
    if (timer) clearTimeout(timer);
    this.writeTimers.delete(path);
    this.observers.get(path)?.();
    this.observers.delete(path);
    this.lastLocalData.delete(path);
    this.localReads.delete(path);
    this.syncManager.releaseDoc(`${CANVAS_DOC_PREFIX}${path}`);
  }

  async handleLocalModify(rawPath: string): Promise<void> {
    const path = toCanonicalPath(normalizePath(rawPath));
    if (this.flushingLocalViews.has(path)) return;
    const subscription = this.subscriptions.get(path);
    if (!subscription) return;
    const handle = this.syncManager.getDoc(`${CANVAS_DOC_PREFIX}${path}`);
    const file = getFileByPath(this.vault, toLocalPath(path));
    if (!handle || !file) return;
    const read = {};
    this.localReads.set(path, read);
    const data = parseCanvas(await this.vault.read(file));
    if (
      !data ||
      this.subscriptions.get(path) !== subscription ||
      this.localReads.get(path) !== read
    )
      return;
    const previous = this.lastLocalData.get(path) ?? emptyCanvas();
    if (equal(data, previous)) return;
    this.applyLocalData(path, data, previous);
    this.scheduleDiskWrite(path, subscription);
  }

  private applyLocalData(path: string, data: CanvasData, previous: CanvasData, saved = true): void {
    if (equal(data, previous)) return;
    const handle = this.syncManager.getDoc(`${CANVAS_DOC_PREFIX}${path}`);
    if (!handle) return;
    // Apply the user's delta, not the entire saved snapshot. The view may still
    // be missing a remote card/position that arrived during the debounce window.
    handle.doc.transact(() => {
      applyItems(handle.doc.getMap("nodes"), data.nodes, previous.nodes);
      applyItems(handle.doc.getMap("edges"), data.edges, previous.edges);
      applyProperties(handle.doc.getMap("properties"), data.properties, previous.properties);
      applyOrder(handle.doc.getMap("nodeOrder"), data.nodeOrder, previous.nodeOrder);
      applyOrder(handle.doc.getMap("edgeOrder"), data.edgeOrder, previous.edgeOrder);
      const meta = handle.doc.getMap("meta");
      if (this.roles.get(path) === "host" && !meta.get("seeded")) meta.set("seeded", true);
    }, this);
    if (saved) this.lastLocalData.set(path, data);
    this.localReads.delete(path);
  }

  isSubscribed(rawPath: string): boolean {
    return this.subscriptions.has(toCanonicalPath(normalizePath(rawPath)));
  }

  destroy(): void {
    for (const path of [...this.subscriptions.keys()]) this.unsubscribe(path);
  }

  private scheduleDiskWrite(path: string, subscription: object): void {
    const timer = this.writeTimers.get(path);
    if (timer) clearTimeout(timer);
    this.writeTimers.set(
      path,
      setTimeout(() => {
        this.writeTimers.delete(path);
        void this.writeToDisk(path, subscription);
      }, DEBOUNCE_MS),
    );
  }

  private async writeToDisk(path: string, subscription: object): Promise<void> {
    const task = (this.writeQueues.get(path) ?? Promise.resolve()).then(async () => {
      if (this.subscriptions.get(path) !== subscription) return;
      const handle = this.syncManager.getDoc(`${CANVAS_DOC_PREFIX}${path}`);
      if (!handle) return;
      const nodes = handle.doc.getMap<Y.Map<unknown>>("nodes");
      const edges = handle.doc.getMap<Y.Map<unknown>>("edges");
      if (!handle.doc.getMap("meta").get("seeded") && nodes.size === 0 && edges.size === 0) return;
      const diskPath = toLocalPath(path);
      // Any outstanding local read predates the fresh save/read below.
      this.localReads.delete(path);
      if (this.localViews) {
        let ready: boolean;
        this.flushingLocalViews.add(path);
        try {
          ready = this.localViews.capturePendingChanges(diskPath, (content, baseline) => {
            if (this.subscriptions.get(path) !== subscription) return false;
            const next = parseCanvas(content);
            const previous = parseCanvas(baseline);
            if (!next || !previous) return false;
            this.applyLocalData(path, next, previous, false);
            return true;
          });
        } finally {
          this.flushingLocalViews.delete(path);
        }
        if (this.subscriptions.get(path) !== subscription) return;
        if (!ready) {
          this.scheduleDiskWrite(path, subscription);
          return;
        }
      }
      const parentDir = diskPath.substring(0, diskPath.lastIndexOf("/"));
      if (parentDir) await ensureFolder(this.vault, parentDir);
      const file = getFileByPath(this.vault, diskPath);
      let existing: CanvasData | null = null;
      let previous = this.lastLocalData.get(path);
      for (let attempt = 0; attempt < 2; attempt++) {
        previous = this.lastLocalData.get(path);
        existing = file ? parseCanvas(await this.vault.read(file)) : null;
        if (this.subscriptions.get(path) !== subscription) return;
        if (previous === this.lastLocalData.get(path)) break;
        if (attempt === 1) {
          this.scheduleDiskWrite(path, subscription);
          return;
        }
      }
      if (this.subscriptions.get(path) !== subscription) return;
      // Also ingest a save whose vault event is still being processed. Build
      // the outgoing snapshot only after these asynchronous reads/flushes.
      if (existing && previous) this.applyLocalData(path, existing, previous);
      if (this.localViews?.hasPendingChanges(diskPath)) {
        this.scheduleDiskWrite(path, subscription);
        return;
      }
      const content = this.serialize(handle.doc);
      const data = parseCanvas(content);
      if (!data) return;
      // Obsidian serializes Canvas differently from our shared document. An
      // equivalent rewrite still reloads an open card and can discard text
      // typed since its last save. Only write actual graph changes.
      if (equal(existing, data)) {
        this.lastLocalData.set(path, data);
        return;
      }
      if (this.subscriptions.get(path) !== subscription) return;
      this.fileOpsManager.mutePathEvents(diskPath);
      let restoreViews: (() => void) | undefined;
      const diskBaseline = this.lastLocalData.get(path);
      try {
        if (this.subscriptions.get(path) !== subscription) return;
        // Once this graph becomes visible it is the user's edit baseline, even
        // though persistence is still pending. A deliberate revert must count.
        restoreViews = this.localViews?.applyMergedData(diskPath, content);
        if (restoreViews) this.lastLocalData.set(path, data);
        await this.vault.adapter.write(diskPath, content);
        if (this.subscriptions.get(path) === subscription) {
          this.lastLocalData.set(path, data);
          if (this.serialize(handle.doc) !== content) this.scheduleDiskWrite(path, subscription);
        }
      } catch (error) {
        restoreViews?.();
        if (this.lastLocalData.get(path) === data) {
          if (diskBaseline) this.lastLocalData.set(path, diskBaseline);
          else this.lastLocalData.delete(path);
        }
        throw error;
      } finally {
        setTimeout(() => {
          this.fileOpsManager.unmutePathEvents(diskPath);
        }, VAULT_EVENT_SETTLE_MS);
      }
    });
    const settled = task.catch(() => {
      new Notice(`Live Share: failed to write canvas ${toLocalPath(path)}`);
    });
    this.writeQueues.set(path, settled);
    await settled;
    if (this.writeQueues.get(path) === settled) this.writeQueues.delete(path);
  }

  private serialize(doc: Y.Doc): string {
    return JSON.stringify(
      {
        ...doc.getMap("properties").toJSON(),
        nodes: orderedItems(doc.getMap("nodes"), doc.getMap("nodeOrder")),
        edges: orderedItems(doc.getMap("edges"), doc.getMap("edgeOrder")),
      },
      null,
      "\t",
    );
  }
}
