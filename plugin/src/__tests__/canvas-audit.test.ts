import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CanvasWorkspace } from "../files/canvas-workspace";
import { path, client, link, mountView, seed } from "./helpers/canvas-client";

describe("Canvas asynchronous saves", () => {
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

  it("does not roll back a local save that completes during a slower incoming-write read", async () => {
    const host = make();
    await host.canvas.subscribe(path, "host");
    const node = host.sync
      .getDoc(`__canvas__:${path}`)
      .doc.getMap<Y.Map<unknown>>("nodes")
      .get("seed")!;
    const earlierDisk = host.files.get(path)!;
    let finishRead!: (s: string) => void;
    let started = false;
    host.vault.read.mockImplementationOnce(() => {
      started = true;
      return new Promise((resolve) => {
        finishRead = resolve;
      });
    });
    node.set("y", 200);
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toBe(true);
    host.files.set(path, JSON.stringify({ ...seed, nodes: [{ ...seed.nodes[0], x: 100 }] }));
    await host.canvas.handleLocalModify(path);
    expect(node.get("x")).toBe(100);
    finishRead(earlierDisk);
    await vi.advanceTimersByTimeAsync(1);
    expect(node.get("x")).toBe(100);
    expect(JSON.parse(host.files.get(path)!).nodes[0]).toMatchObject({ x: 100, y: 200 });
  });

  it("preserves edits made while the host plugin was unloaded and a guest retained the shared document", async () => {
    const host = make();
    const guest = make();
    await host.canvas.subscribe(path, "host");
    link(host, guest);
    await guest.canvas.subscribe(path, "guest");
    const state = Y.encodeStateAsUpdate(guest.sync.getDoc(`__canvas__:${path}`).doc);
    host.canvas.destroy();
    const edited = { ...seed, nodes: [{ ...seed.nodes[0], text: "Offline work" }] };
    const resumed = make(new Map([[path, JSON.stringify(edited)]]));
    Y.applyUpdate(resumed.sync.getDoc(`__canvas__:${path}`).doc, state, "remote");
    await resumed.canvas.subscribe(path, "host");
    expect(JSON.parse(resumed.files.get(path)!).nodes[0].text).toBe("Offline work");
  });

  it("retains a newly restored card after a remote deletion has been rendered", async () => {
    const host = make();
    await host.canvas.subscribe(path, "host");
    const doc = host.sync.getDoc(`__canvas__:${path}`).doc;
    doc.getMap("nodes").delete("seed");
    await vi.advanceTimersByTimeAsync(1100);
    expect(JSON.parse(host.files.get(path)!).nodes).toEqual([]);
    host.files.set(path, JSON.stringify(seed));
    await host.canvas.handleLocalModify(path);
    expect(doc.getMap("nodes").has("seed")).toBe(true);
  });

  it("renders a remote update that lands during the initial hydration write", async () => {
    const host = make();
    const guest = make(new Map());
    await host.canvas.subscribe(path, "host");
    link(host, guest);
    guest.vault.adapter.write.mockImplementationOnce(async (name, content) => {
      guest.files.set(name, content);
      host.sync
        .getDoc(`__canvas__:${path}`)
        .doc.getMap<Y.Map<unknown>>("nodes")
        .get("seed")!
        .set("x", 100);
    });
    await guest.canvas.subscribe(path, "guest");
    await vi.advanceTimersByTimeAsync(2200);
    expect(JSON.parse(guest.files.get(path)!).nodes[0].x).toBe(100);
  });

  it("captures all dirty leaves without invoking a per-view save", async () => {
    const leaves: any[] = [];
    const host = make(undefined, new CanvasWorkspace({ getLeavesOfType: () => leaves } as any));
    await host.canvas.subscribe(path, "host");
    const first = mountView(host, leaves);
    const second = mountView(host, leaves);
    first.graph.nodes[0].x = 100;
    second.graph.nodes[0].y = 200;
    first.dirty = second.dirty = true;
    const firstSave = vi.spyOn(first, "save");
    const secondSave = vi.spyOn(second, "save");
    host.sync
      .getDoc(`__canvas__:${path}`)
      .doc.getMap<Y.Map<unknown>>("nodes")
      .get("seed")!
      .set("width", 400);
    await vi.advanceTimersByTimeAsync(1100);
    expect(firstSave).not.toHaveBeenCalled();
    expect(secondSave).not.toHaveBeenCalled();
    expect(first.graph.nodes[0]).toMatchObject({ x: 100, y: 200, width: 400 });
    expect(second.graph).toEqual(first.graph);
  });

  it("gives native autosaves the merged graph while the adapter write is pending", async () => {
    const leaves: any[] = [];
    const host = make(undefined, new CanvasWorkspace({ getLeavesOfType: () => leaves } as any));
    await host.canvas.subscribe(path, "host");
    const view = mountView(host, leaves);
    view.graph.nodes[0].x = 100;
    view.dirty = true;
    let finishWrite!: () => void;
    host.vault.adapter.write.mockImplementationOnce(async (_name, content) => {
      expect(view.graph.nodes[0]).toMatchObject({ x: 100, y: 200 });
      await view.save();
      await new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
      host.files.set(path, content);
    });
    host.sync
      .getDoc(`__canvas__:${path}`)
      .doc.getMap<Y.Map<unknown>>("nodes")
      .get("seed")!
      .set("y", 200);
    await vi.advanceTimersByTimeAsync(1000);
    finishWrite();
    await vi.advanceTimersByTimeAsync(1100);
    expect(JSON.parse(host.files.get(path)!).nodes[0]).toMatchObject({ x: 100, y: 200 });
  });

  it("keeps a newer edit published while an older adapter write is pending", async () => {
    const host = make();
    await host.canvas.subscribe(path, "host");
    let finishWrite!: () => void;
    host.vault.adapter.write.mockImplementationOnce(async (_name, content) => {
      await new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
      host.files.set(path, content);
    });
    const node = host.sync
      .getDoc(`__canvas__:${path}`)
      .doc.getMap<Y.Map<unknown>>("nodes")
      .get("seed")!;
    node.set("y", 200);
    await vi.advanceTimersByTimeAsync(1000);
    host.files.set(path, JSON.stringify({ ...seed, nodes: [{ ...seed.nodes[0], x: 100 }] }));
    await host.canvas.handleLocalModify(path);
    finishWrite();
    await vi.advanceTimersByTimeAsync(1200);
    expect(node.get("x")).toBe(100);
    expect(JSON.parse(host.files.get(path)!).nodes[0]).toMatchObject({ x: 100, y: 200 });
  });

  it("hydrates a remotely created canvas without reseeding the host's stale file", async () => {
    const guest = make(
      new Map([[path, JSON.stringify({ ...seed, nodes: [{ ...seed.nodes[0], x: 100 }] })]]),
    );
    const host = make();
    await host.background.startAll("host");
    host.canvas.unsubscribe(path);
    await guest.canvas.subscribe(path, "host");
    link(guest, host);
    await host.background.onFileAdded(path);
    expect(JSON.parse(host.files.get(path)!).nodes[0].x).toBe(100);
  });
});
