import { TFile } from "obsidian";
import { vi } from "vitest";
import * as Y from "yjs";
import { BackgroundSync } from "../../files/background-sync";
import { CanvasSync } from "../../files/canvas-sync";
import type { CanvasWritePreparation } from "../../files/canvas-workspace";

export const path = "shared/board.canvas";
export const seed = {
  nodes: [{ id: "seed", type: "text", text: "Hello", x: 0, y: 0, width: 200, height: 100 }],
  edges: [],
  metadata: { version: "1.0", frontmatter: { keep: true } },
};

export function client(
  initial = new Map([[path, JSON.stringify(seed)]]),
  localViews?: CanvasWritePreparation,
) {
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
    releaseDoc: vi.fn((name: string) => {
      docs.get(name)?.doc.destroy();
      docs.delete(name);
    }),
  };
  const fileOps = { mutePathEvents: vi.fn(), unmutePathEvents: vi.fn() };
  const entries = new Map([...files].map(([name]) => [name, { hash: "initial", binary: false }]));
  const manifest = { getEntries: () => entries, updateFile: vi.fn(async () => {}) };
  const canvas = new CanvasSync(vault as any, sync as any, fileOps as any, localViews);
  const background = new BackgroundSync(
    vault as any,
    sync as any,
    manifest as any,
    fileOps as any,
    canvas,
  );
  return { files, docs, vault, sync, fileOps, entries, manifest, canvas, background };
}

export function mountView(c: ReturnType<typeof client>, leaves: any[]) {
  const view = {
    file: { path },
    dirty: false,
    saving: false,
    lastSavedData: c.files.get(path)!,
    data: JSON.parse(c.files.get(path)!),
    canvas: { nodes: new Map() },
    getViewData() {
      return JSON.stringify(this.data);
    },
    setViewData(content: string) {
      this.data = JSON.parse(content);
    },
    async save() {
      this.dirty = false;
      this.lastSavedData = this.getViewData();
      c.files.set(path, this.lastSavedData);
      for (const leaf of leaves) {
        if (leaf.view !== this && !leaf.view.saving) {
          leaf.view.data = JSON.parse(this.lastSavedData);
          leaf.view.lastSavedData = this.lastSavedData;
        }
      }
      await c.canvas.handleLocalModify(path);
    },
  };
  leaves.push({ view });
  c.vault.adapter.write.mockImplementation(async (name, content) => {
    c.files.set(name, content);
    for (const leaf of leaves) {
      leaf.view.data = JSON.parse(content);
      leaf.view.lastSavedData = content;
    }
  });
  return view;
}

export function link(a: ReturnType<typeof client>, b: ReturnType<typeof client>) {
  const aDoc = a.sync.getDoc(`__canvas__:${path}`).doc;
  const bDoc = b.sync.getDoc(`__canvas__:${path}`).doc;
  const fromA = (update: Uint8Array, origin: unknown) => {
    if (origin !== "remote") Y.applyUpdate(bDoc, update, "remote");
  };
  const fromB = (update: Uint8Array, origin: unknown) => {
    if (origin !== "remote") Y.applyUpdate(aDoc, update, "remote");
  };
  const unlink = () => {
    aDoc.off("update", fromA);
    bDoc.off("update", fromB);
  };
  aDoc.on("update", fromA);
  bDoc.on("update", fromB);
  aDoc.on("destroy", unlink);
  bDoc.on("destroy", unlink);
  Y.applyUpdate(bDoc, Y.encodeStateAsUpdate(aDoc), "remote");
  Y.applyUpdate(aDoc, Y.encodeStateAsUpdate(bDoc), "remote");
}
