import type { Workspace } from "obsidian";

export interface CanvasWritePreparation {
  flushPendingChanges(
    path: string,
    applySnapshot: (content: string, previous: string) => void,
  ): Promise<boolean>;
  hasPendingChanges(path: string): boolean;
}

// Canvas's save timing is not part of its exported API. Keep these runtime
// details in one adapter, separate from the Yjs/disk synchronization code.
interface CanvasView {
  file?: { path: string };
  dirty?: boolean;
  saving?: boolean;
  lastSavedData?: string | null;
  getViewData(): string;
  save(): Promise<void>;
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
  constructor(private workspace: Workspace) {}

  private views(path: string): CanvasView[] {
    return this.workspace
      .getLeavesOfType("canvas")
      .map((leaf) => leaf.view as unknown as CanvasView)
      .filter((view) => view.file?.path === path);
  }

  hasPendingChanges(path: string): boolean {
    return this.views(path).some(
      (view) =>
        view.dirty ||
        view.saving ||
        [...(view.canvas?.nodes.values() ?? [])].some((node) => node.child?.dirty),
    );
  }

  async flushPendingChanges(
    path: string,
    applySnapshot: (content: string, previous: string) => void,
  ): Promise<boolean> {
    for (const view of this.views(path)) {
      // A text card has its own debounce before the board's save debounce.
      for (const node of view.canvas?.nodes.values() ?? []) {
        if (node.child?.dirty) node.child.requestSave?.run?.();
      }
      // A running save may have updated lastSavedData before disk catches up.
      // Retry after it settles instead of overwriting it or waiting indefinitely.
      if (view.saving) return false;
      if (!view.dirty) continue;
      if (typeof view.lastSavedData !== "string") return false;
      // Each view has its own baseline: a second stale view must not undo a
      // different view's changes to other cards or properties.
      applySnapshot(view.getViewData(), view.lastSavedData);
      await view.save();
    }
    return !this.hasPendingChanges(path);
  }
}
