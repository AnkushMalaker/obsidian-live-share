import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CanvasWorkspace } from "../files/canvas-workspace";
import { ManifestManager } from "../files/manifest";
import { path, client, link, mountView, seed } from "./helpers/canvas-client";

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
    await host.background.onLocalFileAdded(path);
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

  it("keeps an unsaved card move when another card's remote move arrives first", async () => {
    const board = { ...seed, nodes: [...seed.nodes, { ...seed.nodes[0], id: "second", x: 300 }] };
    const host = make(new Map([[path, JSON.stringify(board)]]));
    const leaves: any[] = [];
    const guest = make(undefined, new CanvasWorkspace({ getLeavesOfType: () => leaves } as any));
    await host.canvas.subscribe(path, "host");
    link(host, guest);
    await guest.canvas.subscribe(path, "guest");
    const view = mountView(guest, leaves);
    view.data.nodes[1].x = 500;
    view.dirty = true; // Visible on screen, not on disk or Yjs yet.
    host.files.set(
      path,
      JSON.stringify({ ...board, nodes: [{ ...board.nodes[0], x: 100 }, board.nodes[1]] }),
    );
    await host.canvas.handleLocalModify(path);
    await vi.advanceTimersByTimeAsync(2200);
    for (const c of [host, guest]) {
      expect(JSON.parse(c.files.get(path)!).nodes.map((n: any) => n.x)).toEqual([100, 500]);
    }
    expect(view.data.nodes.map((n: any) => n.x)).toEqual([100, 500]);
  });

  it("uses each dirty view's baseline when flushing two views of the same canvas", async () => {
    const leaves: any[] = [];
    const host = make(undefined, new CanvasWorkspace({ getLeavesOfType: () => leaves } as any));
    await host.canvas.subscribe(path, "host");
    const first = mountView(host, leaves);
    const second = mountView(host, leaves);
    first.data.nodes[0].x = 100;
    second.data.nodes[0].y = 200;
    first.dirty = second.dirty = true;
    host.sync
      .getDoc(`__canvas__:${path}`)
      .doc.getMap<Y.Map<unknown>>("nodes")
      .get("seed")!
      .set("width", 400);
    await vi.advanceTimersByTimeAsync(2200);
    expect(JSON.parse(host.files.get(path)!).nodes[0]).toMatchObject({
      x: 100,
      y: 200,
      width: 400,
    });
  });

  it("defers incoming writes while a Canvas save is already in flight", async () => {
    const leaves: any[] = [];
    const host = make(undefined, new CanvasWorkspace({ getLeavesOfType: () => leaves } as any));
    await host.canvas.subscribe(path, "host");
    const view = mountView(host, leaves);
    view.data.nodes[0].x = 100;
    view.dirty = view.saving = true;
    host.sync
      .getDoc(`__canvas__:${path}`)
      .doc.getMap<Y.Map<unknown>>("nodes")
      .get("seed")!
      .set("y", 200);
    await vi.advanceTimersByTimeAsync(1100);
    expect(host.vault.adapter.write).not.toHaveBeenCalled();
    expect(view.data.nodes[0].x).toBe(100);
    view.saving = false;
    await vi.advanceTimersByTimeAsync(2200);
    expect(JSON.parse(host.files.get(path)!).nodes[0]).toMatchObject({ x: 100, y: 200 });
  });

  it("rechecks dirty views after the asynchronous disk read", async () => {
    const leaves: any[] = [];
    const host = make(undefined, new CanvasWorkspace({ getLeavesOfType: () => leaves } as any));
    await host.canvas.subscribe(path, "host");
    const view = mountView(host, leaves);
    host.sync
      .getDoc(`__canvas__:${path}`)
      .doc.getMap<Y.Map<unknown>>("nodes")
      .get("seed")!
      .set("y", 200);
    host.vault.read.mockImplementationOnce(async () => {
      view.data.nodes[0].x = 100;
      view.dirty = true;
      return host.files.get(path)!;
    });
    await vi.advanceTimersByTimeAsync(1100);
    expect(host.vault.adapter.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2200);
    expect(JSON.parse(host.files.get(path)!).nodes[0]).toMatchObject({ x: 100, y: 200 });
  });

  it("ingests a newer local disk save before its modify event has run", async () => {
    const host = make();
    await host.canvas.subscribe(path, "host");
    host.sync
      .getDoc(`__canvas__:${path}`)
      .doc.getMap<Y.Map<unknown>>("nodes")
      .get("seed")!
      .set("y", 200);
    host.files.set(path, JSON.stringify({ ...seed, nodes: [{ ...seed.nodes[0], x: 100 }] }));
    await vi.advanceTimersByTimeAsync(1100);
    expect(JSON.parse(host.files.get(path)!).nodes[0]).toMatchObject({ x: 100, y: 200 });
  });

  it("serializes the latest remote state after asynchronous disk reads", async () => {
    const host = make();
    await host.canvas.subscribe(path, "host");
    const shared = host.sync
      .getDoc(`__canvas__:${path}`)
      .doc.getMap<Y.Map<unknown>>("nodes")
      .get("seed")!;
    shared.set("y", 200);
    host.vault.read.mockImplementationOnce(async () => {
      shared.set("x", 100);
      return host.files.get(path)!;
    });
    await vi.advanceTimersByTimeAsync(1100);
    expect(JSON.parse(host.files.get(path)!).nodes[0]).toMatchObject({ x: 100, y: 200 });
  });

  it("flushes a pending text-card editor before applying a remote position", async () => {
    const leaves: any[] = [];
    const host = make(undefined, new CanvasWorkspace({ getLeavesOfType: () => leaves } as any));
    await host.canvas.subscribe(path, "host");
    const view = mountView(host, leaves);
    const child = {
      dirty: true,
      requestSave: {
        run: vi.fn(() => {
          child.dirty = false;
          view.data.nodes[0].text = "Hi, my name is John.";
          view.dirty = true;
        }),
      },
    };
    view.canvas.nodes.set("seed", { child });
    host.sync
      .getDoc(`__canvas__:${path}`)
      .doc.getMap<Y.Map<unknown>>("nodes")
      .get("seed")!
      .set("x", 100);
    await vi.advanceTimersByTimeAsync(1100);
    expect(child.requestSave.run).toHaveBeenCalledOnce();
    expect(JSON.parse(host.files.get(path)!).nodes[0]).toMatchObject({
      x: 100,
      text: "Hi, my name is John.",
    });
  });

  it("ignores a slow local read that finishes after a newer merged write", async () => {
    const host = make();
    await host.canvas.subscribe(path, "host");
    const local = JSON.stringify({ ...seed, nodes: [{ ...seed.nodes[0], x: 100 }] });
    host.files.set(path, local);
    let finishRead!: (content: string) => void;
    host.vault.read.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishRead = resolve;
        }),
    );
    const pending = host.canvas.handleLocalModify(path);
    host.sync
      .getDoc(`__canvas__:${path}`)
      .doc.getMap<Y.Map<unknown>>("nodes")
      .get("seed")!
      .set("y", 200);
    await vi.advanceTimersByTimeAsync(1100);
    finishRead(local);
    await pending;
    expect(
      host.sync
        .getDoc(`__canvas__:${path}`)
        .doc.getMap<Y.Map<unknown>>("nodes")
        .get("seed")!
        .get("y"),
    ).toBe(200);
    await vi.advanceTimersByTimeAsync(1100);
    expect(JSON.parse(host.files.get(path)!).nodes[0]).toMatchObject({ x: 100, y: 200 });
  });

  it("does not echo a local save back over newer, unsaved text in an open card", async () => {
    const host = make();
    const guest = make();
    await host.canvas.subscribe(path, "host");
    link(host, guest);
    await guest.canvas.subscribe(path, "guest");

    const prefix = { ...seed, nodes: [{ ...seed.nodes[0], text: "Hi, my name is " }] };
    // Obsidian has saved the prefix, but its text-card editor already contains
    // the next word. An external adapter write reloads that editor from disk.
    host.files.set(path, JSON.stringify(prefix));
    await host.canvas.handleLocalModify(path);
    let editorText = "Hi, my name is John.";
    host.vault.adapter.write.mockImplementation(async (name, content) => {
      host.files.set(name, content);
      editorText = JSON.parse(content).nodes[0].text;
    });
    await vi.advanceTimersByTimeAsync(1100);

    expect(editorText).toBe("Hi, my name is John.");
    expect(host.vault.adapter.write).not.toHaveBeenCalled();
    expect(JSON.parse(guest.files.get(path)!).nodes[0].text).toBe("Hi, my name is ");

    host.files.set(
      path,
      JSON.stringify({ ...prefix, nodes: [{ ...prefix.nodes[0], text: editorText }] }),
    );
    await host.canvas.handleLocalModify(path);
    await vi.advanceTimersByTimeAsync(1100);
    expect(JSON.parse(guest.files.get(path)!).nodes[0].text).toBe(editorText);
  });

  it("ignores JSON formatting and object-key order when hydrating an unchanged canvas", async () => {
    const host = make();
    const guest = make();
    await host.canvas.subscribe(path, "host");
    link(host, guest);
    // Canvas extensions and core Canvas can serialize the same graph differently.
    const reordered = {
      edges: [],
      metadata: seed.metadata,
      nodes: [Object.fromEntries(Object.entries(seed.nodes[0]).reverse())],
    };
    guest.files.set(path, JSON.stringify(reordered, null, 2));
    await guest.canvas.subscribe(path, "guest");
    expect(guest.vault.adapter.write).not.toHaveBeenCalled();
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
    expect(host.fileOps.mutePathEvents).toHaveBeenCalledWith(path);
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
