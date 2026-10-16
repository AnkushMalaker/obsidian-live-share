import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { CanvasWorkspace } from "../files/canvas-workspace";
import { path, client, mountView, seed } from "./helpers/canvas-client";

describe("Canvas native serialization", () => {
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

  it("accepts equivalent native whitespace and object-key order and does not schedule another graph write", async () => {
    const leaves: any[] = [];
    const c = make(undefined, new CanvasWorkspace({ getLeavesOfType: () => leaves } as any));
    await c.canvas.subscribe(path, "host");
    const view = mountView(c, leaves);
    view.getViewData = function () {
      const nodes = this.data.nodes.map((node: any) =>
        Object.fromEntries(Object.entries(node).sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))),
      );
      return JSON.stringify(
        { edges: this.data.edges, nodes, metadata: this.data.metadata },
        null,
        2,
      );
    };
    c.sync
      .getDoc(`__canvas__:${path}`)
      .doc.getMap<Y.Map<unknown>>("nodes")
      .get("seed")!
      .set("y", 200);
    await vi.advanceTimersByTimeAsync(1100);
    expect(JSON.parse(c.files.get(path)!).nodes[0].y).toBe(200);
    expect(view.lastSavedData).toBe(view.getViewData());
    expect(c.files.get(path)).toBe(view.getViewData());
    expect(c.vault.adapter.write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.vault.adapter.write).toHaveBeenCalledTimes(1);
  });

  it("still hydrates valid edges when native Canvas supplies omitted optional sides", async () => {
    const leaves: any[] = [];
    const board = { ...seed, nodes: [...seed.nodes, { ...seed.nodes[0], id: "second", x: 300 }] };
    const c = make(
      new Map([[path, JSON.stringify(board)]]),
      new CanvasWorkspace({ getLeavesOfType: () => leaves } as any),
    );
    await c.canvas.subscribe(path, "host");
    const view = mountView(c, leaves);
    // Installed native importData mutates the incoming edge object to add these
    // sides before assigning canvas.data; canvas.d.ts marks both as optional.
    view.setViewData = function (content: string) {
      this.data = JSON.parse(content);
      this.data.metadata.frontmatter.nativeDefault = true;
      for (const edge of this.data.edges) {
        edge.fromSide ??= "right";
        edge.toSide ??= "left";
      }
    };
    const doc = c.sync.getDoc(`__canvas__:${path}`).doc;
    doc.transact(() => {
      doc.getMap<Y.Map<unknown>>("nodes").get("seed")!.set("y", 200);
      doc.getMap<Y.Map<unknown>>("edges").set(
        "edge",
        new Y.Map<unknown>([
          ["id", "edge"],
          ["fromNode", "seed"],
          ["toNode", "second"],
        ]),
      );
    });
    await vi.advanceTimersByTimeAsync(6000);
    const disk = JSON.parse(c.files.get(path)!);
    expect(disk.nodes[0].y).toBe(200);
    expect(disk.edges).toHaveLength(1);
    expect(disk.metadata.frontmatter).toMatchObject({ keep: true, nativeDefault: true });
    expect(doc.getMap<Y.Map<unknown>>("edges").get("edge")?.get("fromSide")).toBe("right");
    expect(c.vault.adapter.write).toHaveBeenCalledTimes(1);
  });
});
