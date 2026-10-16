import type { Workspace } from "obsidian";

export interface CanvasWritePreparation {
  capturePendingChanges(
    path: string,
    applySnapshot: (content: string, previous: string) => boolean,
  ): boolean;
  hasPendingChanges(path: string): boolean;
  applyMergedData(path: string, content: string): (() => void) | undefined;
}

// Canvas save state is not exported in Obsidian's public types.
interface CanvasView {
  file?: { path: string };
  dirty?: boolean;
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
      if (!view.dirty) return false;
      const captured = this.captured.get(view);
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

  applyMergedData(path: string, content: string): (() => void) | undefined {
    const views = this.views(path);
    if (!views.length) return undefined;
    const previous = views.map((view) => ({ view, baseline: view.lastSavedData }));
    for (const view of views) {
      view.setViewData(content, false);
      // Match TextFileView.save's optimistic baseline. Otherwise reverting a
      // visible remote edit can equal the old lastSavedData and save() silently
      // drops it. The matching baseline also prevents our watcher event from
      // reloading a leaf that has accumulated newer input during this write.
      view.lastSavedData = content;
      view.dirty = false;
    }
    return () => {
      for (const { view, baseline } of previous) {
        // A newer native save owns its own baseline and recovery.
        if (view.file?.path !== path || view.lastSavedData !== content || view.saving) continue;
        view.lastSavedData = baseline;
        view.dirty = true;
        view.requestSave?.();
      }
    };
  }
}
