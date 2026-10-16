import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { CanvasWorkspace } from "../files/canvas-workspace";
import { path, client, seed } from "./helpers/canvas-client";

describe("Canvas loaded-string cache", () => {
  let c: ReturnType<typeof client>;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    c.canvas.destroy();
    c.background.destroy();
    for (const { doc } of c.docs.values()) doc.destroy();
    vi.useRealTimers();
  });

  it("renders a disk revert to the file opened before the incoming merge", async () => {
    const leaves: any[] = [];
    const original = JSON.stringify(seed);
    c = client(
      new Map([[path, original]]),
      new CanvasWorkspace({ getLeavesOfType: () => leaves } as any),
    );
    await c.canvas.subscribe(path, "host");
    const view = {
      file: { path },
      dirty: false,
      saving: false,
      // Obsidian Q4.data is the loaded string, distinct from Canvas.canvas.data.
      data: original,
      lastSavedData: original,
      graph: JSON.parse(original),
      getViewData() {
        return JSON.stringify(this.graph);
      },
      setViewData(content: string) {
        this.graph = JSON.parse(content);
      },
      setData(content: string, clear: boolean) {
        if (this.data !== content || clear) {
          this.data = content;
          this.setViewData(content);
        }
      },
      onModify(content: string) {
        // Q4.loadFileInternal, clean non-plaintext path, from installed 1.14.4.
        const previous = this.lastSavedData;
        this.lastSavedData = content;
        if (previous && previous === content) return;
        this.setData(content, false);
      },
    };
    leaves.push({ view });
    c.vault.adapter.write.mockImplementation(async (name, content) => {
      c.files.set(name, content);
      view.onModify(content);
    });
    const node = c.sync
      .getDoc(`__canvas__:${path}`)
      .doc.getMap<Y.Map<unknown>>("nodes")
      .get("seed")!;
    node.set("x", 100);
    await vi.advanceTimersByTimeAsync(1100);
    expect(view.graph.nodes[0].x).toBe(100);
    expect(view.lastSavedData).toBe(c.files.get(path));
    expect(view.data).toBe(view.getViewData());

    // An external edit, or another leaf's native undo/save, writes the original.
    c.files.set(path, original);
    view.onModify(original);
    await c.canvas.handleLocalModify(path);
    await vi.advanceTimersByTimeAsync(2200);
    expect(node.get("x")).toBe(0);
    expect(JSON.parse(c.files.get(path)!).nodes[0].x).toBe(0);
    expect(view.graph.nodes[0].x).toBe(0);
  });
});
