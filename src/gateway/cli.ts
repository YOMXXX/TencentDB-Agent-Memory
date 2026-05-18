#!/usr/bin/env node
/**
 * `tdai-memory-gateway` — standalone Gateway daemon entry.
 *
 * Exposed as a `bin` in package.json so users can run:
 *   npx tdai-memory-gateway           # from a project that depends on the package
 *   tdai-memory-gateway               # after `npm install -g @tencentdb-agent-memory/memory-tencentdb`
 *
 * Reads config from environment variables (see src/gateway/config.ts):
 *   TDAI_TOKEN_PATH     path to a 0600 file holding the Bearer token (preferred —
 *                       avoids leaking the token via /proc/<pid>/environ / `ps -E`)
 *   TDAI_GATEWAY_TOKEN  Bearer token (fallback for Hermes-style direct env passing)
 *   TDAI_GATEWAY_PORT   port to bind (default 8420)
 *   TDAI_GATEWAY_HOST   bind host (default 127.0.0.1). Non-loopback values require
 *                       TDAI_GATEWAY_ALLOW_REMOTE=1 to opt in (defence in depth).
 *   TDAI_DATA_DIR       data root
 *   TDAI_CC_PID         (optional) parent process pid; daemon self-exits when it dies
 *
 * Designed for use by host-agnostic plugins (Claude Code, Codex CLI) that spawn
 * the Gateway as a sidecar without bundling npm dependencies.
 */

import { TdaiGateway, applyStartupSafety } from "./server.js";

async function main(): Promise<void> {
  applyStartupSafety();
  const gateway = new TdaiGateway();
  await gateway.start();

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await Promise.race([
        gateway.stop(),
        new Promise<void>((r) => setTimeout(r, 5_000)),
      ]);
    } catch {
      // best effort
    }
    process.exit(reason === "error" ? 1 : 0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  const ccPid = parseInt(process.env.TDAI_CC_PID ?? "0", 10);
  if (Number.isFinite(ccPid) && ccPid > 0) {
    // Poll every 15s — short enough that a vanished cc doesn't keep the
    // daemon alive long enough to collide with a fresh hook spawning a
    // replacement, long enough that the syscall load stays negligible.
    const timer = setInterval(() => {
      try {
        process.kill(ccPid, 0);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "ESRCH") {
          clearInterval(timer);
          void shutdown("parent-exit");
        }
      }
    }, 15_000);
    timer.unref();
  }
}

main().catch((err) => {
  process.stderr.write(`tdai-memory-gateway failed: ${String(err)}\n`);
  process.exit(1);
});
