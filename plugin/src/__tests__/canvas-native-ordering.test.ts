import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { CanvasWorkspace } from "../files/canvas-workspace";
import { path, client, link, mountView, seed } from "./helpers/canvas-client";

describe("Canvas native save ordering", () => {
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

  it("does not reinterpret a local read begun during an older incoming write against its new baseline", async () => {
    const leaves: any[] = [];
    const host = make(undefined, new CanvasWorkspace({ getLeavesOfType: () => leaves } as any));
    await host.canvas.subscribe(path, "host");
    const view = mountView(host, leaves);
    const node = host.sync
      .getDoc(`__canvas__:${path}`)
      .doc.getMap<Y.Map<unknown>>("nodes")
      .get("seed")!;
    const oldDisk = host.files.get(path)!;
    let finishIncomingRead!: (content: string) => void;
    host.vault.read.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishIncomingRead = resolve;
        }),
    );
    node.set("y", 200);
    await vi.advanceTimersByTimeAsync(1000);
    let finishLocalRead!: (content: string) => void;
    host.vault.read.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishLocalRead = resolve;
        }),
    );
    view.data.nodes[0].x = 100;
    view.dirty = true;
    const readingLocal = view.save();
    const local = host.files.get(path)!;
    finishIncomingRead(oldDisk);
    await vi.advanceTimersByTimeAsync(1);
    expect(view.data.nodes[0].x).toBe(100);
    finishLocalRead(local);
    await readingLocal;
    await vi.advanceTimersByTimeAsync(1100);
    expect(JSON.parse(host.files.get(path)!).nodes[0]).toMatchObject({ x: 100, y: 200 });
  });

  it("does not let a queued native autosave reload a newer dirty sibling after the incoming merge", async () => {
    const leaves: any[] = [];
    const host = make(undefined, new CanvasWorkspace({ getLeavesOfType: () => leaves } as any));
    await host.canvas.subscribe(path, "host");
    const first = mountView(host, leaves);
    const second = mountView(host, leaves);
    // Model Q4.save's real string-equality gate, and Canvas's isPlaintext=false
    // sibling reload. Compact JSON is a stand-in for native Yb formatting;
    // Installed Obsidian 1.14.4 uses a different native JSON formatter.
    first.save = async function () {
      this.dirty = false;
      const content = this.getViewData();
      if (content === this.lastSavedData || this.lastSavedData === null) return;
      this.lastSavedData = content;
      this.saving = true;
      host.files.set(path, content);
      if (!second.saving && second.lastSavedData !== content) {
        second.lastSavedData = content;
        if (second.getViewData() !== content) second.data = JSON.parse(content);
      }
      this.saving = false;
      await host.canvas.handleLocalModify(path);
    };
    first.data.nodes[0].x = 100;
    first.dirty = true;
    // Native requestSave's existing two-second callback survives dirty=false.
    setTimeout(() => void first.save(), 2000);
    host.sync
      .getDoc(`__canvas__:${path}`)
      .doc.getMap<Y.Map<unknown>>("nodes")
      .get("seed")!
      .set("y", 200);
    await vi.advanceTimersByTimeAsync(1100);
    expect(first.data.nodes[0]).toMatchObject({ x: 100, y: 200 });
    expect(first.getViewData()).toBe(first.lastSavedData);
    second.data.nodes[0].height = 300;
    second.dirty = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(second.data.nodes[0].height).toBe(300);
  });
});
