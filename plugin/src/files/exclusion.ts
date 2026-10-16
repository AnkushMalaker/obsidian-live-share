import { minimatch } from "minimatch";
import { normalizePath, toCanonicalPath } from "../utils";

export class ExclusionManager {
  private patterns: string[] = [];
  private configDir = "";
  private localLogPath = "";

  setConfigDir(configDir: string): void {
    this.configDir = configDir;
  }

  setPatterns(custom: string[]): void {
    this.patterns = [`${this.configDir}/**`, ".trash/**", ...custom];
  }

  setLocalLogPath(path: string): void {
    this.localLogPath = toCanonicalPath(normalizePath(path)).replace(/^\.\//, "");
  }

  isExcluded(path: string): boolean {
    if (toCanonicalPath(normalizePath(path)).replace(/^\.\//, "") === this.localLogPath)
      return true;
    return this.patterns.some((pattern) => minimatch(path, pattern));
  }
}
