import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { CanvasWorkspace } from "../files/canvas-workspace";
import { path, client, link, mountView, seed } from "./helpers/canvas-client";

describe("Canvas formats and pending writes", () => {
  const clients: ReturnType<typeof client>[] = [];
  const make = (...args: Parameters<typeof client>) => {
    const c = client(...args);
    clients.push(c);
    return c;
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

  it("hydrates an untouched native Canvas (Obsidian creates it as a zero-byte file)", async () => {
    const host = make(new Map([[path, ""]]));
    const guest = make(new Map());
    await host.background.startAll("host");
    guest.entries.set(path, { hash: "empty-native-canvas", binary: false });
    link(host, guest);
    await guest.background.startAll("guest");
    await vi.advanceTimersByTimeAsync(3000);
    expect(guest.files.has(path)).toBe(true);
  });

  it("seeds a valid JSON Canvas with the optional edges array omitted", async () => {
    const host = make(new Map([[path, JSON.stringify({ nodes: seed.nodes })]]));
    await host.canvas.subscribe(path, "host");
    expect(host.sync.getDoc(`__canvas__:${path}`).doc.getMap("nodes").has("seed")).toBe(true);
  });

  it("persists a reversal of a visible remote move through the native save baseline", async () => {
    const leaves: any[] = [];
    const initial = JSON.stringify({ nodes: seed.nodes, edges: [] }, null, "\t");
    const host = make(
      new Map([[path, initial]]),
      new CanvasWorkspace({ getLeavesOfType: () => leaves } as any),
    );
    await host.canvas.subscribe(path, "host");
    const view = mountView(host, leaves);
    view.getViewData = () => JSON.stringify(view.data, null, "\t");
    let finishWrite!: () => void;
    const adapterQueue = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    view.save = async function () {
      this.dirty = false;
      const content = this.getViewData();
      if (content === this.lastSavedData || this.lastSavedData === null) return;
      this.lastSavedData = content;
      this.saving = true;
      await adapterQueue;
      host.files.set(path, content);
      this.saving = false;
      await host.canvas.handleLocalModify(path);
    };
    host.vault.adapter.write.mockImplementationOnce(async (name, content) => {
      await adapterQueue;
      host.files.set(name, content);
      if (view.lastSavedData !== content && !view.saving) {
        view.data = JSON.parse(content);
        view.lastSavedData = content;
      }
    });
    const node = host.sync
      .getDoc(`__canvas__:${path}`)
      .doc.getMap<Y.Map<unknown>>("nodes")
      .get("seed")!;
    node.set("x", 100);
    await vi.advanceTimersByTimeAsync(1000);
    expect(view.data.nodes[0].x).toBe(100);
    expect(JSON.parse(view.lastSavedData).nodes[0].x).toBe(100);
    view.data.nodes[0].x = 0;
    view.dirty = true;
    const saving = view.save();
    expect(view.saving).toBe(true);
    finishWrite();
    await saving;
    await vi.advanceTimersByTimeAsync(3000);
    expect(node.get("x")).toBe(0);
    expect(JSON.parse(host.files.get(path)!).nodes[0].x).toBe(0);
    expect(view.data.nodes[0].x).toBe(0);
  });

  it("restores the native save baseline after a failed adapter write without reverting input", async () => {
    const leaves: any[] = [];
    const host = make(undefined, new CanvasWorkspace({ getLeavesOfType: () => leaves } as any));
    await host.canvas.subscribe(path, "host");
    const view = mountView(host, leaves);
    const baseline = view.lastSavedData;
    const requestSave = vi.fn();
    Object.assign(view, { requestSave });
    host.vault.adapter.write.mockRejectedValueOnce(new Error("disk unavailable"));
    host.sync
      .getDoc(`__canvas__:${path}`)
      .doc.getMap<Y.Map<unknown>>("nodes")
      .get("seed")!
      .set("x", 100);
    await vi.advanceTimersByTimeAsync(1000);
    expect(view.data.nodes[0].x).toBe(100);
    expect(view.lastSavedData).toBe(baseline);
    expect(view.dirty).toBe(true);
    expect(requestSave).toHaveBeenCalledOnce();
  });
});
