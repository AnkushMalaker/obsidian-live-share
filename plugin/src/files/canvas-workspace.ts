import type { Workspace } from "obsidian";

export interface CanvasWritePreparation {
  capturePendingChanges(
    path: string,
    applySnapshot: (content: string, previous: string) => boolean,
  ): boolean;
  hasPendingChanges(path: string): boolean;
  applyMergedData(path: string, content: string): void;
}

// Canvas save state is not exported in Obsidian's public types.
interface CanvasView {
  file?: { path: string };
  dirty?: boolean;
  saving?: boolean;
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

  applyMergedData(path: string, content: string): void {
    // Pending native autosaves must see the merged graph, not a stale leaf's
    // snapshot, while the adapter write is in flight.
    for (const view of this.views(path)) view.setViewData(content, false);
  }
}
