import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "live-share-package-"));
const prefix = join(root, "installed");
const directory = join(root, "relay data & config");
let child;
let output = "";
let passed = false;
let installedService = false;
let cli;
const testService = process.argv.includes("--service");
if (testService) assert.equal(process.platform, "darwin", "Service smoke requires macOS.");

function command(args) {
  const result = spawnSync(
    "npm",
    [...args, "--cache", join(root, "npm-cache"), "--no-audit", "--no-fund"],
    { cwd: source, encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([stopped, pause(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await stopped;
    throw new Error("Relay failed to shut down gracefully.");
  }
  assert.equal(child.exitCode, 0, output);
}

try {
  const [{ filename }] = JSON.parse(
    command(["pack", "--ignore-scripts", "--json", "--pack-destination", root]),
  );
  command(["install", "--global", "--prefix", prefix, join(root, filename)]);
  cli = join(prefix, "bin", "obsidian-live-share-relay");
  const help = spawnSync(cli, ["--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /install-service/);
  const invalidDirectory = join(root, "must-not-be-created");
  const invalid = spawnSync(cli, ["run", "--port", "12garbage", "--directory", invalidDirectory], {
    encoding: "utf8",
  });
  assert.equal(invalid.status, 1);
  await assert.rejects(stat(invalidDirectory), { code: "ENOENT" });

  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  async function start() {
    output = "";
    child = spawn(
      cli,
      ["run", "--directory", directory, "--port", String(port), "--host", "127.0.0.1"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, output);
      try {
        const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(300) });
        if (response.ok && (await response.json()).ok) return;
      } catch {
        /* Listener may not yet exist. */
      }
      await pause(50);
    }
    throw new Error(`Packed relay did not start. ${output}`);
  }
  await start();
  const envPath = join(directory, ".env");
  const original = await readFile(envPath, "utf8");
  const config = parseEnv(original);
  // Preserve apparent assignments inside a quoted multiline credential.
  const preservationDirectory = join(root, "quoted configuration");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(preservationDirectory);
  const quoted =
    'SERVER_PASSWORD="line one\nPORT=secret-part\nHOST=another-part\nline three"\nJWT_SECRET="test-secret"\nPORT=3000\n';
  const quotedPath = join(preservationDirectory, ".env");
  await writeFile(quotedPath, quoted, { mode: 0o600 });
  // Startup can subsequently fail on its listener; configuration preservation
  // must hold independently. A live child is shut down before continuing.
  const quotedProcess = spawn(
    cli,
    [
      "run",
      "--directory",
      preservationDirectory,
      "--port",
      String(await availablePort()),
      "--host",
      "127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const quotedExit = new Promise((resolve) => quotedProcess.once("exit", resolve));
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (await readFile(quotedPath, "utf8")) === quoted)
      await pause(25);
    const updated = parseEnv(await readFile(quotedPath, "utf8"));
    assert.equal(updated.SERVER_PASSWORD, parseEnv(quoted).SERVER_PASSWORD);
    assert.equal(updated.JWT_SECRET, "test-secret");
    assert.equal(updated.HOST, "127.0.0.1");
    assert.notEqual(updated.PORT, "3000");
  } finally {
    if (quotedProcess.exitCode === null && quotedProcess.signalCode === null)
      quotedProcess.kill("SIGTERM");
    await Promise.race([quotedExit, pause(5000)]);
    if (quotedProcess.exitCode === null && quotedProcess.signalCode === null) {
      quotedProcess.kill("SIGKILL");
      await quotedExit;
    }
  }
  assert.equal(config.PORT, String(port));
  assert.equal(config.SERVER_PASSWORD.length, 48);
  assert.equal(config.JWT_SECRET.length, 64);
  if (process.platform !== "win32") assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  const headers = {
    "x-server-password": config.SERVER_PASSWORD,
    "content-type": "application/json",
  };
  assert.equal(
    (
      await fetch(`${url}/rooms`, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      })
    ).status,
    401,
  );
  const response = await fetch(`${url}/rooms`, {
    method: "POST",
    body: JSON.stringify({ hostUserId: "package-smoke", name: "package-smoke" }),
    headers,
  });
  assert.equal(response.status, 201);
  const room = await response.json();
  assert.equal(typeof room.id, "string");
  await stop();
  await start();
  assert.equal(
    await readFile(envPath, "utf8"),
    original,
    "Restart changed existing credentials/configuration.",
  );
  const restored = await fetch(`${url}/rooms/${room.id}`, { headers });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).name, room.name);
  const rejoined = await fetch(`${url}/rooms/${room.id}/join`, {
    method: "POST",
    headers,
    body: JSON.stringify({ token: room.token }),
  });
  assert.equal(rejoined.status, 200);
  assert.equal((await rejoined.json()).id, room.id);
  await stop();
  if (testService) {
    const service = (action) => {
      const result = spawnSync(cli, [action, "--directory", directory], {
        encoding: "utf8",
        timeout: 20_000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout;
    };
    installedService = true;
    assert.match(service("install-service"), /Installed:/);
    assert.match(service("status"), /Service: loaded/);
    assert.match(service("install-service"), /already loaded/);
    assert.equal(await readFile(envPath, "utf8"), original);
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    assert.equal((await fetch(`${url}/rooms/${room.id}`, { headers })).status, 200);
    service("uninstall-service");
    installedService = false;
    assert.match(service("status"), /Service: not loaded/);
    assert.equal(await readFile(envPath, "utf8"), original);
    assert.equal((await stat(join(directory, "data"))).isDirectory(), true);
    console.log(
      "PASS native macOS service: install, startup, status, repeated install, room persistence and removal retaining data.",
    );
  }
  passed = true;
  console.log(
    "PASS packed global CLI: help, port validation, authenticated startup, graceful shutdown, restart, configuration and room persistence.",
  );
} finally {
  if (installedService)
    spawnSync(cli, ["uninstall-service", "--directory", directory], { encoding: "utf8" });
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  if (passed) await rm(root, { recursive: true, force: true });
  else console.error(`Package test files retained: ${root}`);
}
