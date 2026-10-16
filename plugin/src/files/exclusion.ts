import { minimatch } from "minimatch";

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
    this.localLogPath = path.replaceAll("\\", "/").replace(/^\.\//, "");
  }

  isExcluded(path: string): boolean {
    if (path.replaceAll("\\", "/").replace(/^\.\//, "") === this.localLogPath) return true;
    return this.patterns.some((pattern) => minimatch(path, pattern));
  }
}
