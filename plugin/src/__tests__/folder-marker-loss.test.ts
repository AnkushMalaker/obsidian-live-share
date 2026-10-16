import { TFile, TFolder } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { FileOpsManager } from "../files/file-ops";
import { ManifestManager } from "../files/manifest";
import LiveSharePlugin from "../main";
import { registerControlHandlers } from "../sync/control-handlers";
import { DEFAULT_SETTINGS } from "../types";

vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  FuzzySuggestModal: class {},
}));

const docs: Y.Doc[] = [];
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

function fixture(existingEntry = true) {
  const file = Object.assign(new TFile(), { path: "Job/luna.canvas" });
  const folder = Object.assign(new TFolder(), { path: "Job", children: [file] });
  const files = new Map<string, any>([
    [folder.path, folder],
    [file.path, file],
  ]);
  const vault = {
    getAbstractFileByPath: (path: string) => files.get(path),
    getFiles: () => [file],
    getAllLoadedFiles: () => [folder, file],
    read: async () => "{}",
    rename: vi.fn(),
    createFolder: vi.fn(),
  };
  const manager = new ManifestManager(vault as any, { ...DEFAULT_SETTINGS });
  const doc = new Y.Doc();
  docs.push(doc);
  const entries = doc.getMap<any>("files");
  Object.assign(manager, { manifest: entries, docHandle: { doc } });
  entries.set("Job", { directory: true, hash: "", size: 0, mtime: 0 });
  if (existingEntry) entries.set(file.path, { hash: "before", size: 2, mtime: 0 });
  const trashFile = vi.fn(async (item: any) => {
    files.delete(item.path);
  });
  const plugin: any = Object.create(LiveSharePlugin.prototype);
  Object.assign(plugin, {
    app: { vault, fileManager: { trashFile } },
    manifestManager: manager,
    manifestHandlerQueue: Promise.resolve(),
    fileOpsManager: { mutePathEvents: vi.fn(), unmutePathEvents: vi.fn() },
    backgroundSync: { onFileRemoved: vi.fn(), onFileAdded: vi.fn() },
    logger: { log: vi.fn(), error: vi.fn() },
    notify: vi.fn(),
  });
  plugin.registerManifestChangeHandler();
  return { plugin, manager, doc, entries, folder, file, files, vault, trashFile };
}

describe("folder inventory markers", () => {
  it("keeps a populated folder when saving a child retires its empty-folder marker", async () => {
    const f = fixture();
    await f.manager.updateFile(f.file, '{"nodes":[],"edges":[]}');
    await f.plugin.manifestHandlerQueue;
    expect(f.trashFile).not.toHaveBeenCalled();
    expect(f.files.has("Job")).toBe(true);
  });
  it("keeps the folder when its first child is added", async () => {
    const f = fixture(false);
    await f.manager.updateFile(f.file, "first child");
    await f.plugin.manifestHandlerQueue;
    expect(f.trashFile).not.toHaveBeenCalled();
    expect(f.vault.rename).not.toHaveBeenCalled();
    expect(f.entries.has(f.file.path)).toBe(true);
  });

  it("ignores a late folder-create notification for a populated directory", async () => {
    const f = fixture();
    f.entries.delete("Job");
    await f.plugin.manifestHandlerQueue;
    f.manager.addFolder("Job");
    expect(f.entries.has("Job")).toBe(false);
    expect(f.trashFile).not.toHaveBeenCalled();
  });

  it("does not trash folders when a complete inventory drops obsolete markers", async () => {
    const f = fixture();
    await f.manager.publishManifest({ purge: true });
    await f.plugin.manifestHandlerQueue;
    expect(f.entries.has("Job")).toBe(false);
    expect(f.trashFile).not.toHaveBeenCalled();
  });

  it("keeps both client folders when the marker removal reaches a peer", async () => {
    const host = fixture();
    const guest = fixture();
    Y.applyUpdate(host.doc, Y.encodeStateAsUpdate(guest.doc));
    Y.applyUpdate(guest.doc, Y.encodeStateAsUpdate(host.doc));
    await host.plugin.manifestHandlerQueue;
    await guest.plugin.manifestHandlerQueue;
    host.doc.on("update", (update) => Y.applyUpdate(guest.doc, update));
    await host.manager.updateFile(host.file, "saved child");
    await host.plugin.manifestHandlerQueue;
    await guest.plugin.manifestHandlerQueue;
    expect(host.trashFile).not.toHaveBeenCalled();
    expect(guest.trashFile).not.toHaveBeenCalled();
  });

  it("never infers a directory rename from unrelated inventory changes", async () => {
    const f = fixture();
    f.doc.transact(() => {
      f.entries.delete("Job");
      f.entries.set("new-note.md", { hash: "new", size: 3, mtime: 0 });
    });
    await f.plugin.manifestHandlerQueue;
    expect(f.vault.rename).not.toHaveBeenCalled();
    expect(f.trashFile).not.toHaveBeenCalled();
  });

  it("keeps physical directories even if a removed entry was misclassified as a file", async () => {
    const f = fixture();
    f.entries.set("Job", { hash: "malformed marker", size: 0, mtime: 0 });
    f.entries.delete("Job");
    await f.plugin.manifestHandlerQueue;
    expect(f.trashFile).not.toHaveBeenCalled();
    expect(f.plugin.logger.log).toHaveBeenCalledWith("manifest-folder-kept", expect.any(String));
  });

  it("continues applying actual file deletions", async () => {
    const f = fixture();
    f.entries.delete(f.file.path);
    await f.plugin.manifestHandlerQueue;
    expect(f.trashFile).toHaveBeenCalledExactlyOnceWith(f.file);
    expect(f.files.has("Job")).toBe(true);
  });

  it("preserves both folders when an explicit remote rename collides", async () => {
    const f = fixture();
    const destination = Object.assign(new TFolder(), { path: "Existing", children: [] });
    f.files.set("Existing", destination);
    const manager = new FileOpsManager(f.vault as any, { trashFile: f.trashFile } as any);
    try {
      await manager.applyRemoteOp({ type: "rename", oldPath: "Job", newPath: "Existing" });
      expect(f.trashFile).not.toHaveBeenCalled();
      expect(f.files.has("Job")).toBe(true);
      expect(f.files.has("Existing")).toBe(true);
    } finally {
      manager.destroy();
    }
  });
  it.each(["folder", "file"])(
    "keeps the source and manifest on a full control-channel rename collision with a %s",
    async (kind) => {
      const f = fixture();
      const destination =
        kind === "folder"
          ? Object.assign(new TFolder(), { path: "Existing", children: [] })
          : Object.assign(new TFile(), { path: "Existing" });
      f.files.set("Existing", destination);
      f.entries.set("Existing", {
        directory: kind === "folder",
        hash: "destination",
        size: 0,
        mtime: 0,
      });
      const manager = new FileOpsManager(f.vault as any, { trashFile: f.trashFile } as any);
      const handlers = new Map<string, (message: any) => void>();
      Object.assign(f.plugin, {
        settings: { ...DEFAULT_SETTINGS, role: "host" },
        fileOpsManager: manager,
        syncManager: { releaseDoc: vi.fn() },
        controlChannel: {
          send: vi.fn(),
          on: (type: string, handler: any) => handlers.set(type, handler),
        },
      });
      registerControlHandlers(f.plugin);
      try {
        handlers.get("file-op")?.({
          op: { type: "rename", oldPath: f.file.path, newPath: "Existing" },
        });
        await (manager as any).opQueues.get(f.file.path);
        await f.plugin.manifestHandlerQueue;
        expect(f.trashFile).not.toHaveBeenCalled();
        expect(f.entries.get(f.file.path)?.hash).toBe("before");
        expect(f.entries.get("Existing")?.hash).toBe("destination");
        expect(f.files.has(f.file.path)).toBe(true);
      } finally {
        manager.destroy();
      }
    },
  );
  it("does not commit a rename if a destination appears during the filesystem operation", async () => {
    const f = fixture();
    f.vault.rename.mockImplementationOnce(async () => {
      f.files.set("Existing", Object.assign(new TFolder(), { path: "Existing", children: [] }));
      throw new Error("destination appeared concurrently");
    });
    const manager = new FileOpsManager(f.vault as any, { trashFile: f.trashFile } as any);
    const commit = vi.fn();
    try {
      expect(
        await manager.applyRemoteOp(
          { type: "rename", oldPath: f.file.path, newPath: "Existing" },
          commit,
        ),
      ).toBe(false);
      expect(commit).not.toHaveBeenCalled();
      expect(f.files.has(f.file.path)).toBe(true);
      expect(f.trashFile).not.toHaveBeenCalled();
    } finally {
      manager.destroy();
    }
  });
});
