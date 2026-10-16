import { TFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BackgroundSync } from "../files/background-sync";
import { CanvasSync } from "../files/canvas-sync";
import { ManifestManager } from "../files/manifest";

const path = "shared/board.canvas";
const seed = {
  nodes: [{ id: "seed", type: "text", text: "Hello", x: 0, y: 0, width: 200, height: 100 }],
  edges: [],
  metadata: { version: "1.0", frontmatter: { keep: true } },
};

function client(initial = new Map([[path, JSON.stringify(seed)]])) {
  const files = new Map(initial);
  const docs = new Map<string, { doc: Y.Doc; text: Y.Text }>();
  const vault = {
    read: vi.fn(async (file: TFile) => files.get(file.path) ?? ""),
    getAbstractFileByPath: vi.fn((name: string) => {
      if (!files.has(name)) return null;
      const file = new TFile();
      file.path = name;
      return file;
    }),
    adapter: {
      write: vi.fn(async (name: string, content: string) => {
        files.set(name, content);
      }),
    },
  };
  const sync = {
    getDoc(name: string) {
      if (!docs.has(name)) {
        const doc = new Y.Doc();
        docs.set(name, { doc, text: doc.getText("content") });
      }
      return docs.get(name)!;
    },
    waitForSync: vi.fn(async () => {}),
    releaseDoc: vi.fn(),
  };
  const fileOps = { mutePathEvents: vi.fn(), unmutePathEvents: vi.fn() };
  const entries = new Map([...files].map(([name]) => [name, { hash: "initial", binary: false }]));
  const manifest = { getEntries: () => entries, updateFile: vi.fn(async () => {}) };
  const canvas = new CanvasSync(vault as any, sync as any, fileOps as any);
  const background = new BackgroundSync(
    vault as any,
    sync as any,
    manifest as any,
    fileOps as any,
    canvas,
  );
  return { files, docs, vault, sync, fileOps, entries, manifest, canvas, background };
}

function link(a: ReturnType<typeof client>, b: ReturnType<typeof client>) {
  const aDoc = a.sync.getDoc(`__canvas__:${path}`).doc;
  const bDoc = b.sync.getDoc(`__canvas__:${path}`).doc;
  aDoc.on("update", (update, origin) => {
    if (origin !== "remote") Y.applyUpdate(bDoc, update, "remote");
  });
  bDoc.on("update", (update, origin) => {
    if (origin !== "remote") Y.applyUpdate(aDoc, update, "remote");
  });
  Y.applyUpdate(bDoc, Y.encodeStateAsUpdate(aDoc), "remote");
  Y.applyUpdate(aDoc, Y.encodeStateAsUpdate(bDoc), "remote");
}

describe("Canvas session regressions", () => {
  const clients: ReturnType<typeof client>[] = [];
  const make = (...args: Parameters<typeof client>) => {
    const instance = client(...args);
    clients.push(instance);
    return instance;
  };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const c of clients.splice(0)) {
      c.canvas.destroy();
      c.background.destroy();
      for (const { doc } of c.docs.values()) doc.destroy();
    }
    vi.useRealTimers();
  });

  it("starts Canvas sync from the loaded manifest without a competing text document", async () => {
    const host = make();
    await host.background.startAll("host");
    const doc = host.sync.getDoc(`__canvas__:${path}`).doc;
    expect(doc.getMap("nodes").has("seed")).toBe(true);
    expect(host.docs.has(path)).toBe(false);
  });

  it("routes a canvas created after session startup through Canvas sync", async () => {
    const host = make(new Map());
    await host.background.startAll("host");
    host.files.set(path, JSON.stringify(seed));
    await host.background.onFileAdded(path);
    const doc = host.sync.getDoc(`__canvas__:${path}`).doc;
    expect(doc.getMap("nodes").has("seed")).toBe(true);
    expect(host.docs.has(path)).toBe(false);
  });

  it("preserves Advanced Canvas metadata when a guest receives a linked card", async () => {
    const host = make();
    const guest = make(new Map());
    await host.canvas.subscribe(path, "host");
    link(host, guest);
    await guest.canvas.subscribe(path, "guest");
    expect(JSON.parse(guest.files.get(path)!)).toEqual(seed);
  });

  it("keeps a remote linked card when a second user saves a stale canvas view", async () => {
    const host = make();
    const guest = make();
    await host.canvas.subscribe(path, "host");
    link(host, guest);
    await guest.canvas.subscribe(path, "guest");

    const linked = { id: "linked", type: "file", file: "shared/note.md", x: 300, y: 0 };
    const edge = { id: "link", fromNode: "seed", toNode: "linked" };
    host.files.set(
      path,
      JSON.stringify({ ...seed, nodes: [...seed.nodes, linked], edges: [edge] }),
    );
    await host.canvas.handleLocalModify(path);

    // The remote update has arrived, but the debounced disk/view refresh has not.
    const own = { id: "guest-card", type: "text", text: "On the other laptop", x: 600, y: 0 };
    guest.files.set(path, JSON.stringify({ ...seed, nodes: [...seed.nodes, own] }));
    await guest.canvas.handleLocalModify(path);
    await vi.advanceTimersByTimeAsync(1100);

    for (const c of [host, guest]) {
      const data = JSON.parse(c.files.get(path)!);
      expect(data.nodes.map((n: any) => n.id).sort()).toEqual(["guest-card", "linked", "seed"]);
      expect(data.metadata).toEqual(seed.metadata);
      expect(data.edges).toEqual([edge]);
    }
  });

  it("merges independent changes to the same card instead of restoring stale properties", async () => {
    const host = make();
    const guest = make();
    await host.canvas.subscribe(path, "host");
    link(host, guest);
    await guest.canvas.subscribe(path, "guest");
    host.files.set(path, JSON.stringify({ ...seed, nodes: [{ ...seed.nodes[0], x: 400 }] }));
    await host.canvas.handleLocalModify(path);
    guest.files.set(path, JSON.stringify({ ...seed, nodes: [{ ...seed.nodes[0], height: 300 }] }));
    await guest.canvas.handleLocalModify(path);
    await vi.advanceTimersByTimeAsync(1100);
    for (const c of [host, guest]) {
      expect(JSON.parse(c.files.get(path)!).nodes[0]).toMatchObject({ x: 400, height: 300 });
    }
  });

  it("does not erase the shared board when a temporary save contains invalid JSON", async () => {
    const host = make();
    await host.canvas.subscribe(path, "host");
    host.files.set(path, '{"nodes":[');
    await host.canvas.handleLocalModify(path);
    expect(host.sync.getDoc(`__canvas__:${path}`).doc.getMap("nodes").has("seed")).toBe(true);
  });

  it("hydrates an empty canvas, including deleting the last card, on a joining guest", async () => {
    const host = make(new Map([[path, JSON.stringify({ ...seed, nodes: [] })]]));
    const guest = make();
    await host.canvas.subscribe(path, "host");
    link(host, guest);
    await guest.canvas.subscribe(path, "guest");
    expect(JSON.parse(guest.files.get(path)!).nodes).toEqual([]);
  });

  it("does not hydrate Canvas JSON from the ordinary text document during initial file sync", async () => {
    const guest = make(new Map());
    const manager = new ManifestManager(guest.vault as any, {} as any);
    const doc = new Y.Doc();
    const manifest = doc.getMap("files");
    manifest.set(path, { hash: "canvas", size: 100, mtime: 1 });
    Object.assign(manager, { manifest, docHandle: { doc }, syncManager: guest.sync });
    await manager.syncFromManifest();
    expect(guest.docs.has(path)).toBe(false);
    expect(guest.files.has(path)).toBe(false);
    doc.destroy();
  });

  it("seeds a new canvas created by a guest before the host receives its manifest entry", async () => {
    const guest = make(new Map());
    const host = make(new Map());
    await guest.background.startAll("guest");
    guest.files.set(path, JSON.stringify(seed));
    await guest.background.onLocalFileAdded(path);
    link(host, guest);
    await host.canvas.subscribe(path, "host");
    expect(JSON.parse(host.files.get(path)!)).toEqual(seed);
  });

  it("converges after genuinely concurrent additions on independent Y.Docs", async () => {
    const host = make();
    const guest = make();
    await host.canvas.subscribe(path, "host");
    const a = host.sync.getDoc(`__canvas__:${path}`).doc;
    const b = guest.sync.getDoc(`__canvas__:${path}`).doc;
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "remote");
    await guest.canvas.subscribe(path, "guest");
    const own = (id: string) => ({ id, type: "file", file: "shared/note.md", x: 300, y: 0 });
    host.files.set(path, JSON.stringify({ ...seed, nodes: [...seed.nodes, own("a")] }));
    guest.files.set(path, JSON.stringify({ ...seed, nodes: [...seed.nodes, own("b")] }));
    await host.canvas.handleLocalModify(path);
    await guest.canvas.handleLocalModify(path);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b), "remote");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "remote");
    await vi.advanceTimersByTimeAsync(1100);
    expect(
      JSON.parse(host.files.get(path)!)
        .nodes.map((n: any) => n.id)
        .sort(),
    ).toEqual(["a", "b", "seed"]);
    expect(host.files.get(path)).toBe(guest.files.get(path));
  });

  it("accepts a user edit within the remote-write mute window", async () => {
    const host = make();
    await host.canvas.subscribe(path, "host");
    const doc = host.sync.getDoc(`__canvas__:${path}`).doc;
    doc.getMap<Y.Map<unknown>>("nodes").get("seed")!.set("x", 200);
    await vi.advanceTimersByTimeAsync(1100);
    expect(host.canvas.isRecentDiskWrite(path)).toBe(true);
    const data = JSON.parse(host.files.get(path)!);
    data.nodes[0].y = 500;
    host.files.set(path, JSON.stringify(data));
    await host.canvas.handleLocalModify(path);
    expect(doc.getMap<Y.Map<unknown>>("nodes").get("seed")!.get("y")).toBe(500);
  });

  it("does not resurrect a deleted card when a stale peer moves it", async () => {
    const host = make();
    const guest = make();
    await host.canvas.subscribe(path, "host");
    link(host, guest);
    await guest.canvas.subscribe(path, "guest");
    host.files.set(path, JSON.stringify({ ...seed, nodes: [] }));
    await host.canvas.handleLocalModify(path);
    guest.files.set(path, JSON.stringify({ ...seed, nodes: [{ ...seed.nodes[0], x: 100 }] }));
    await guest.canvas.handleLocalModify(path);
    await vi.advanceTimersByTimeAsync(1100);
    expect(JSON.parse(host.files.get(path)!).nodes).toEqual([]);
    expect(JSON.parse(guest.files.get(path)!).nodes).toEqual([]);
  });

  it("follows a canvas rename and cancels pending writes when the canvas is deleted", async () => {
    const host = make();
    await host.background.startAll("host");
    const renamed = "shared/renamed.canvas";
    host.files.set(renamed, host.files.get(path)!);
    host.files.delete(path);
    await host.background.onFileRenamed(path, renamed);
    expect(host.canvas.isSubscribed(path)).toBe(false);
    const doc = host.sync.getDoc(`__canvas__:${renamed}`).doc;
    doc.getMap<Y.Map<unknown>>("nodes").get("seed")!.set("x", 200);
    host.background.onFileRemoved(renamed);
    host.files.delete(renamed);
    await vi.advanceTimersByTimeAsync(1100);
    expect(host.files.has(renamed)).toBe(false);
    expect(host.files.has(path)).toBe(false);
  });

  it("waits for a later host seed instead of writing an empty JSON document", async () => {
    const guest = make(new Map());
    const host = make();
    link(host, guest);
    await guest.canvas.subscribe(path, "guest");
    expect(guest.files.has(path)).toBe(false);
    await host.canvas.subscribe(path, "host");
    await vi.advanceTimersByTimeAsync(1100);
    expect(JSON.parse(guest.files.get(path)!)).toEqual(seed);
  });
});
