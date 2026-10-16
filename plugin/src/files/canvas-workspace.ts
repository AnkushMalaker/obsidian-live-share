import type { Workspace } from "obsidian";

export interface CanvasWritePreparation {
  capturePendingChanges(
    path: string,
    applySnapshot: (content: string, previous: string) => boolean,
  ): boolean;
  hasPendingChanges(path: string): boolean;
  applyMergedData(
    path: string,
    content: string,
    acceptSerialization: (content: string) => boolean,
  ): { content: string; rollback: () => void } | undefined;
}

// Canvas save state is not exported in Obsidian's public types.
interface CanvasView {
  file?: { path: string };
  dirty?: boolean;
  data?: string;
  saving?: boolean;
  requestSave?: () => void;
  lastSavedData?: string | null;
  getViewData(): string;
  setViewData(content: string, clear: boolean): void;
  canvas?: {
    nodes: Map<
      string,
      {
        child?: { dirty?: boolean; requestSave?: { run?: () => unknown } };
      }
    >;
  };
}

export class CanvasWorkspace implements CanvasWritePreparation {
  private captured = new WeakMap<
    CanvasView,
    { content: string; baseline: string | null | undefined }
  >();

  constructor(private workspace: Workspace) {}

  private views(path: string): CanvasView[] {
    return this.workspace
      .getLeavesOfType("canvas")
      .map((leaf) => leaf.view as unknown as CanvasView)
      .filter((view) => view.file?.path === path);
  }

  private pendingText(view: CanvasView): boolean {
    return [...(view.canvas?.nodes.values() ?? [])].some((node) => node.child?.dirty);
  }

  hasPendingChanges(path: string): boolean {
    return this.views(path).some((view) => {
      if (view.saving || this.pendingText(view)) return true;
      const captured = this.captured.get(view);
      if (!view.dirty && !captured) return false;
      return (
        !captured ||
        captured.content !== view.getViewData() ||
        captured.baseline !== view.lastSavedData
      );
    });
  }

  capturePendingChanges(
    path: string,
    applySnapshot: (content: string, previous: string) => boolean,
  ): boolean {
    const views = this.views(path);
    if (views.some((view) => view.saving)) return false;
    for (const view of views) {
      for (const node of view.canvas?.nodes.values() ?? []) {
        if (node.child?.dirty) node.child.requestSave?.run?.();
      }
    }
    // Capture every leaf before any file write can reload its siblings. Do not
    // call view.save(): only the final merged board should reach disk.
    const snapshots = views.map((view) => ({
      view,
      content: view.getViewData(),
      baseline: view.lastSavedData,
    }));
    if (
      snapshots.some(
        ({ view, baseline }) =>
          view.saving || this.pendingText(view) || (view.dirty && typeof baseline !== "string"),
      )
    )
      return false;
    for (const { view, content, baseline } of snapshots) {
      if (view.dirty && typeof baseline === "string" && !applySnapshot(content, baseline))
        return false;
      this.captured.set(view, { content, baseline });
    }
    return true;
  }

  applyMergedData(
    path: string,
    content: string,
    acceptSerialization: (content: string) => boolean,
  ): { content: string; rollback: () => void } | undefined {
    const views = this.views(path);
    if (!views.length) return undefined;
    const previous = views.map((view) => ({
      view,
      baseline: view.lastSavedData,
      loaded: view.data,
      content: view.getViewData(),
    }));
    for (const view of views) view.setViewData(content, false);
    const nativeContent = views[0].getViewData();
    if (
      views.some((view) => view.getViewData() !== nativeContent) ||
      !acceptSerialization(nativeContent)
    ) {
      for (const { view, content } of previous) view.setViewData(content, false);
      throw new Error("Canvas views cannot serialize the shared graph without changes");
    }
    for (const view of views) {
      // Native requestSave callbacks can still run after dirty is cleared. Use
      // their exact serialization so an unchanged save is a no-op. Writing those
      // same bytes also makes the filesystem watcher skip sibling reloads.
      view.data = nativeContent;
      view.lastSavedData = nativeContent;
      view.dirty = false;
    }
    return {
      content: nativeContent,
      rollback: () => {
        for (const { view, baseline, loaded } of previous) {
          if (view.file?.path !== path || view.lastSavedData !== nativeContent || view.saving)
            continue;
          view.data = loaded;
          view.lastSavedData = baseline;
          view.dirty = true;
          view.requestSave?.();
        }
      },
    };
  }
}
