import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";

const defaultDirectory = join(homedir(), "my-services", "obsidian-live-share-relay");
const cliPath = fileURLToPath(new URL("../bin/relay.mjs", import.meta.url));

function portNumber(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error("Port must be an integer from 1 to 65535.");
  }
  return Number(value);
}

function configuration(directory: string, port?: string, host?: string): Record<string, string> {
  const path = join(directory, ".env");
  const config = existsSync(path)
    ? parseEnv(readFileSync(path, "utf8"))
    : {
        PORT: "3865",
        SERVER_PASSWORD: randomBytes(24).toString("hex"),
        JWT_SECRET: randomBytes(32).toString("hex"),
      };
  config.PORT = String(portNumber(port ?? config.PORT ?? "3865"));
  if (host !== undefined) config.HOST = host;
  return Object.fromEntries(
    Object.entries(config).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function writeConfiguration(directory: string, config: Record<string, string>): void {
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(directory, "logs"), { recursive: true });
  mkdirSync(join(directory, "data"), { recursive: true });
  const path = join(directory, ".env");
  let content: string;
  if (existsSync(path)) {
    content = readFileSync(path, "utf8");
    const previous = parseEnv(content);
    // Preserve credentials, quoting, comments and optional settings verbatim.
    for (const key of ["PORT", "HOST"]) {
      if (config[key] === undefined || previous[key] === config[key]) continue;
      const line = `${key}=${JSON.stringify(config[key])}`;
      // Later assignments override earlier ones. Appending avoids matching
      // apparent assignments inside quoted multiline credentials.
      content = `${content.trimEnd()}\n${line}\n`;
    }
  } else {
    content = `${Object.entries(config)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n")}\n`;
  }
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
}

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function servicePaths(directory: string) {
  if (process.platform !== "darwin" || !process.getuid) {
    throw new Error(
      "Native background service installation is macOS-only. Use run or Docker Compose on this platform.",
    );
  }
  const label = `local.obsidian-live-share-relay.${createHash("sha256").update(directory).digest("hex").slice(0, 12)}`;
  const domain = `gui/${process.getuid()}`;
  return {
    label,
    domain,
    target: `${domain}/${label}`,
    plist: join(homedir(), "Library", "LaunchAgents", `${label}.plist`),
  };
}

function launchctl(...args: string[]) {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

async function requireFreePort(port: number, host?: string): Promise<void> {
  await new Promise<void>((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen({ port, host }, () =>
      probe.close((error) => (error ? reject(error) : resolvePort())),
    );
  });
}

async function waitForHealth(port: number, host?: string, tls = false): Promise<void> {
  const address = !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = `http://${address.includes(":") ? `[${address}]` : address}:${port}/healthz`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      // A local TLS certificate need not name the loopback address. Check its
      // listener without weakening certificate verification for HTTP clients.
      if (tls) {
        await new Promise<void>((connected, failed) => {
          const socket = createConnection({ port, host: address });
          socket.setTimeout(500, () => socket.destroy(new Error("Connection timed out")));
          socket.once("connect", () => {
            socket.destroy();
            connected();
          });
          socket.once("error", failed);
        });
        return;
      }
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok && ((await response.json()) as { ok?: boolean }).ok === true) return;
    } catch {
      /* Startup may still be opening its database/listener. */
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Relay did not become healthy within 10 seconds. Check its logs directory.");
}

async function installService(directory: string, port?: string, host?: string): Promise<void> {
  const service = servicePaths(directory);
  const config = configuration(directory, port, host);
  if (launchctl("print", service.target).status === 0) {
    const current = configuration(directory);
    if (current.PORT !== config.PORT || current.HOST !== config.HOST) {
      throw new Error(
        "Service is already running with different options. Uninstall the service first; its data and configuration will be retained.",
      );
    }
    console.log(
      `Service already loaded: ${service.label}\nConfiguration: ${join(directory, ".env")}`,
    );
    return;
  }
  await requireFreePort(Number(config.PORT), config.HOST || undefined);
  writeConfiguration(directory, config);
  const argumentsXml = [process.execPath, cliPath, "run", "--directory", directory]
    .map((value) => `<string>${xml(value)}</string>`)
    .join("");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${service.label}</string>
<key>ProgramArguments</key><array>${argumentsXml}</array>
<key>WorkingDirectory</key><string>${xml(directory)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(join(directory, "logs", "relay.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(directory, "logs", "relay-error.log"))}</string>
</dict></plist>\n`;
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  const previous = existsSync(service.plist) ? readFileSync(service.plist) : null;
  writeFileSync(service.plist, plist, { mode: 0o644 });
  try {
    const result = launchctl("bootstrap", service.domain, service.plist);
    if (result.status !== 0) throw new Error(result.stderr.trim() || "launchctl bootstrap failed");
    await waitForHealth(
      Number(config.PORT),
      config.HOST,
      Boolean(config.TLS_CERT && config.TLS_KEY),
    );
  } catch (error) {
    launchctl("bootout", service.target);
    if (previous) writeFileSync(service.plist, previous);
    else unlinkSync(service.plist);
    throw error;
  }
  console.log(
    `Installed: ${service.label}\nLocal URL: ${config.TLS_CERT && config.TLS_KEY ? "https" : "http"}://localhost:${config.PORT}\nConfiguration: ${join(directory, ".env")}`,
  );
}

export async function main(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      directory: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      help: { type: "boolean" },
    },
  });
  const command = positionals[0] ?? "run";
  if (values.help) {
    console.log(
      "obsidian-live-share-relay [run|install-service|status|uninstall-service] [--directory PATH] [--port 3865] [--host ADDRESS]\nrun works on Node.js platforms; service commands require macOS. Configuration and data are retained on service removal.",
    );
    return;
  }
  if (
    positionals.length > 1 ||
    !["run", "install-service", "status", "uninstall-service"].includes(command)
  ) {
    throw new Error("Unknown command. Use --help.");
  }
  if (values.directory !== undefined && !values.directory.trim())
    throw new Error("Directory must not be empty.");
  const directory = resolve(values.directory ?? defaultDirectory);
  if (command === "install-service") return installService(directory, values.port, values.host);
  if (command === "status" || command === "uninstall-service") {
    const service = servicePaths(directory);
    const loaded = launchctl("print", service.target).status === 0;
    if (command === "status") {
      console.log(
        `Service: ${loaded ? "loaded" : "not loaded"}\nConfiguration: ${join(directory, ".env")}`,
      );
      return;
    }
    if (loaded) {
      const result = launchctl("bootout", service.target);
      if (result.status !== 0) throw new Error(result.stderr.trim() || "launchctl bootout failed");
    }
    if (existsSync(service.plist)) unlinkSync(service.plist);
    console.log(`Service removed. Configuration, data and logs retained in ${directory}`);
    return;
  }
  const config = configuration(directory, values.port, values.host);
  writeConfiguration(directory, config);
  Object.assign(process.env, config);
  process.chdir(directory);
  const { startServer } = await import("./index.js");
  await startServer();
}
