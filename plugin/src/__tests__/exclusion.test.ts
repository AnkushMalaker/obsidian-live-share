import { Platform } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";
import { ExclusionManager } from "../files/exclusion";

describe("ExclusionManager", () => {
  let manager: ExclusionManager;

  beforeEach(() => {
    manager = new ExclusionManager();
    manager.setConfigDir(".obsidian");
    manager.setPatterns([]);
  });

  describe("default exclusion patterns", () => {
    it("excludes .obsidian/config", () => {
      expect(manager.isExcluded(".obsidian/config")).toBe(true);
    });

    it("excludes deeply nested .obsidian paths", () => {
      expect(manager.isExcluded(".obsidian/plugins/foo/main.js")).toBe(true);
    });

    it("excludes .trash/deleted.md", () => {
      expect(manager.isExcluded(".trash/deleted.md")).toBe(true);
    });

    it("does not exclude a normal note file", () => {
      expect(manager.isExcluded("notes/hello.md")).toBe(false);
    });

    it("does not exclude a root-level file", () => {
      expect(manager.isExcluded("README.md")).toBe(false);
    });

    it("does not exclude a deeply nested normal file", () => {
      expect(manager.isExcluded("folder/subfolder/note.md")).toBe(false);
    });

    it("does not exclude .liveshare.json by default", () => {
      expect(manager.isExcluded(".liveshare.json")).toBe(false);
    });
  });

  describe("local debug log", () => {
    it("keeps the configured log out of shared file events regardless of debug toggle", () => {
      manager.setLocalLogPath("live-share-debug.md");
      manager.setPatterns([]);
      expect(manager.isExcluded("live-share-debug.md")).toBe(true);
      expect(manager.isExcluded("notes/live-share-debug.md")).toBe(false);
    });

    it("excludes the Windows log path using the manifest's canonical spelling", () => {
      const wasWindows = Platform.isWin;
      try {
        Platform.isWin = true;
        manager.setLocalLogPath("logs/debug：local.md");
        expect(manager.isExcluded("logs/debug:local.md")).toBe(true);
      } finally {
        Platform.isWin = wasWindows;
      }
    });

    it("compares log paths literally and normalizes relative separators", () => {
      manager.setLocalLogPath("./logs\\debug[1].md");
      expect(manager.isExcluded("logs/debug[1].md")).toBe(true);
      expect(manager.isExcluded("logs/debug1.md")).toBe(false);
      manager.setLocalLogPath("other.log");
      expect(manager.isExcluded("other.log")).toBe(true);
      expect(manager.isExcluded("logs/debug[1].md")).toBe(false);
    });
  });

  describe("setPatterns", () => {
    it("merges custom patterns with defaults", () => {
      manager.setPatterns(["*.tmp", "drafts/**"]);

      expect(manager.isExcluded("test.tmp")).toBe(true);
      expect(manager.isExcluded("drafts/wip.md")).toBe(true);

      expect(manager.isExcluded(".obsidian/config")).toBe(true);
      expect(manager.isExcluded(".trash/deleted.md")).toBe(true);

      expect(manager.isExcluded("notes/hello.md")).toBe(false);
    });

    it("works with an empty array (defaults only)", () => {
      manager.setPatterns([]);

      expect(manager.isExcluded(".obsidian/config")).toBe(true);
      expect(manager.isExcluded(".trash/deleted.md")).toBe(true);
      expect(manager.isExcluded("notes/hello.md")).toBe(false);
    });

    it("can be called multiple times to replace custom patterns", () => {
      manager.setPatterns(["*.tmp"]);
      expect(manager.isExcluded("test.tmp")).toBe(true);
      expect(manager.isExcluded("private/secret.md")).toBe(false);

      manager.setPatterns(["private/**"]);
      expect(manager.isExcluded("test.tmp")).toBe(false);
      expect(manager.isExcluded("private/secret.md")).toBe(true);
    });
  });
});
