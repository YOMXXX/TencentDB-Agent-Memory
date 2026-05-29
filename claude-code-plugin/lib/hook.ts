/**
 * Unified hook entry point. Dispatched by the first CLI arg.
 *
 * Usage from cc plugin hook config:
 *   node ${CLAUDE_PLUGIN_ROOT}/dist/lib/hook.mjs <event-name>
 *
 * Where <event-name> is one of:
 *   session-start | user-prompt-submit | post-tool-use | stop |
 *   search | status | clear-session
 */

import { GatewayClient } from "./gateway-client.js";
import { getSessionKey } from "./session-key.js";
import { readAllTurns } from "./transcript.js";
import { DaemonManager, readDaemonState, clearDaemonState } from "./daemon.js";
import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_INJECT_CHARS = 10_000;
const MAX_CAPTURE_TURNS = 50;

export type HookEvent =
  | "session-start"
  | "user-prompt-submit"
  | "post-tool-use"
  | "stop"
  | "search"
  | "search-stdin"
  | "status"
  | "clear-session";

export interface HookInput {
  stdin: string;
  client: GatewayClient;
  args?: string[];
}

export async function handleHook(event: HookEvent, input: HookInput): Promise<string> {
  const data = parseStdin(input.stdin);
  switch (event) {
    case "session-start":
      return handleSessionStart(data, input.client);
    case "user-prompt-submit":
      return handleUserPromptSubmit(data, input.client);
    case "post-tool-use":
      return handlePostToolUse(data, input.client);
    case "stop":
      return handleStop(data, input.client);
    case "search":
      return handleSearch(input.args ?? [], input.client);
    case "search-stdin":
      return handleSearchStdin(input.stdin, input.client);
    case "status":
      return handleStatus(input.client);
    case "clear-session":
      return handleClearSession(data, input.client);
    default:
      return "";
  }
}

interface HookStdin {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  source?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  stop_hook_active?: boolean;
}

function parseStdin(raw: string): HookStdin {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as HookStdin;
  } catch {
    return {};
  }
}

async function handleSessionStart(_data: HookStdin, client: GatewayClient): Promise<string> {
  await client.health();
  return "";
}

async function handleUserPromptSubmit(data: HookStdin, client: GatewayClient): Promise<string> {
  const prompt = data.prompt ?? "";
  const cwd = data.cwd ?? process.cwd();
  if (!prompt) return "";

  const sessionKey = getSessionKey(cwd);

  // Primary path: L1/L2/L3 recall (structured atoms + persona + scene).
  const recall = await client.recall(prompt, sessionKey);
  let context = recall.context ?? "";

  // Fallback 1: daemon /search/conversations (FTS5 BM25 on L0 table).
  if (!context) {
    const conv = await client.searchConversations(prompt, {
      limit: 3,
      sessionKey,
    });
    if (conv.total > 0 && conv.results) {
      context = `## Past conversations (relevant to current prompt)\n\n${conv.results}`;
    }
  }

  // Fallback 2: direct L0 jsonl file scan. Covers the case where FTS5 is
  // unavailable (e.g. Node.js built-in node:sqlite lacks fts5 module) AND
  // no embedding service is configured. Reads $TDAI_DATA_DIR/conversations/
  // and does simple keyword matching — no ranking, but good enough to
  // surface relevant history on day zero.
  if (!context) {
    const dataDir = process.env.TDAI_DATA_DIR;
    if (dataDir) {
      context = await searchL0JsonlDirect(join(dataDir, "conversations"), prompt, sessionKey, 3);
    }
  }

  if (!context) return "";

  if (context.length > MAX_INJECT_CHARS) {
    context =
      context.slice(0, MAX_INJECT_CHARS - 100) +
      "\n\n[…recall truncated — use /memory-search for full results…]";
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context,
    },
  });
}

async function handlePostToolUse(_data: HookStdin, _client: GatewayClient): Promise<string> {
  // No-op fallback. PostToolUse capture is intentionally deferred to a
  // follow-up PR — see spec §5.3 for the buffer endpoint design. The
  // hooks.json registration was removed so this handler is unreachable
  // by default; it remains here only as a safety net if someone manually
  // re-enables the PostToolUse hook before the follow-up lands.
  return "";
}

async function handleStop(data: HookStdin, client: GatewayClient): Promise<string> {
  if (data.stop_hook_active === true) return "";
  if (!data.transcript_path) return "";

  // cc may trigger Stop before the last assistant block is flushed to disk.
  // Poll the file size until two consecutive 100ms ticks see identical bytes,
  // capped at 2s. Replaces a fragile 800ms hard sleep that still missed slow
  // disks on real-machine validation.
  await waitForTranscriptStable(data.transcript_path, 2_000);

  const allTurns = await readAllTurns(data.transcript_path);
  if (allTurns.length === 0) return "";

  // Persist a per-session cursor so the next Stop only sends turns appended
  // after this one. Without it, every Stop posts the latest N turns and the
  // Gateway writes them to L0 again, duplicating long sessions across calls.
  const dataDir = resolveDataDir();
  const cursorId = sanitizeCursorId(
    data.session_id ?? (basename(data.transcript_path).replace(/\.jsonl$/, "") || "default"),
  );
  const lastSent = await readCursor(dataDir, cursorId);

  let newTurns = allTurns.slice(lastSent);
  if (newTurns.length === 0) return "";

  // Bound the first capture so a pre-existing long transcript doesn't dump
  // hundreds of turns in a single /capture request.
  if (newTurns.length > MAX_CAPTURE_TURNS) {
    newTurns = newTurns.slice(-MAX_CAPTURE_TURNS);
  }

  const cwd = data.cwd ?? process.cwd();
  const sessionKey = getSessionKey(cwd);

  const messages = newTurns.flatMap((t) => [
    { role: "user" as const, content: t.user },
    { role: "assistant" as const, content: t.assistant },
  ]);

  const lastTurn = newTurns[newTurns.length - 1];
  await client.captureTurn({
    user_content: lastTurn.user,
    assistant_content: lastTurn.assistant,
    messages,
    session_key: sessionKey,
    session_id: data.session_id,
  });
  await writeCursor(dataDir, cursorId, allTurns.length);
  return "";
}

async function waitForTranscriptStable(path: string, maxMs: number): Promise<void> {
  const start = Date.now();
  let lastSize = -1;
  let stableTicks = 0;
  while (Date.now() - start < maxMs) {
    try {
      const st = await stat(path);
      if (st.size === lastSize) {
        stableTicks++;
        if (stableTicks >= 2) return;
      } else {
        stableTicks = 0;
        lastSize = st.size;
      }
    } catch {
      // not yet written
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const PLUGIN_NAME = "tdai-memory";

interface DataDirCandidate {
  dir: string;
  pid: number;
  mtimeMs: number;
}

/**
 * Resolve the gateway data directory.
 *
 * We cannot trust process.env.CLAUDE_PLUGIN_DATA here: Claude Code injects a
 * single plugin's CLAUDE_PLUGIN_DATA into the generic Bash environment, and for
 * slash-command / skill invocations (e.g. /memory-search) it routinely points
 * at a DIFFERENT plugin's data dir. Hooks receive the correct per-plugin value,
 * skills do not — so trusting the env var alone makes every manual search and
 * status check resolve to the wrong dir and return empty.
 *
 * Instead we discover our own data dirs from this script's real on-disk
 * location (env-independent) and pick the one whose daemon PID is actually
 * alive — the gateway that is really running. Ties, and the case where no PID
 * is alive, fall back to the most recently updated state.json.
 */
function resolveDataDir(): string {
  const candidates = findOwnDataDirs();
  if (candidates.length > 0) {
    const alive = candidates.filter((c) => isPidAlive(c.pid));
    const pool = alive.length > 0 ? alive : candidates;
    pool.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return pool[0].dir;
  }
  // Nothing discoverable on disk: trust the env var only if it is ours,
  // otherwise the home-dir fallback (never a foreign plugin's dir).
  const env = process.env.CLAUDE_PLUGIN_DATA;
  if (env && basename(env).startsWith(PLUGIN_NAME)) return env;
  return join(homedir(), ".tdai-memory");
}

/**
 * Discover this plugin's data dirs under <plugins>/data, located via the
 * script's own path: <plugins>/<marketplace>/plugin/dist/lib/hook.mjs.
 */
function findOwnDataDirs(): DataDirCandidate[] {
  const root = pluginsDataRoot();
  if (!root) return [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: DataDirCandidate[] = [];
  for (const name of names) {
    if (!name.startsWith(PLUGIN_NAME)) continue;
    const dir = join(root, name);
    const statePath = join(dir, "state.json");
    try {
      const mtimeMs = statSync(statePath).mtimeMs;
      const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as { pid?: unknown };
      const pid = typeof parsed.pid === "number" ? parsed.pid : 0;
      out.push({ dir, pid, mtimeMs });
    } catch {
      // No readable state.json → not a usable candidate.
    }
  }
  return out;
}

function pluginsDataRoot(): string | null {
  try {
    const self = fileURLToPath(import.meta.url);
    // dist/lib/hook.mjs -> up 4 (lib, dist, plugin, <marketplace>) -> <plugins> -> data
    const root = join(dirname(self), "..", "..", "..", "..", "data");
    return existsSync(root) ? root : null;
  } catch {
    return null;
  }
}

/** True if a process with this PID currently exists (POSIX + Windows). */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM => the process exists but we lack permission to signal it.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sanitizeCursorId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "default";
}

async function readCursor(dataDir: string, cursorId: string): Promise<number> {
  try {
    const raw = await readFile(join(dataDir, "cursors", `${cursorId}.json`), "utf-8");
    const obj = JSON.parse(raw) as { lastSentIndex?: unknown };
    return typeof obj.lastSentIndex === "number" && obj.lastSentIndex >= 0
      ? obj.lastSentIndex
      : 0;
  } catch {
    return 0;
  }
}

async function writeCursor(dataDir: string, cursorId: string, lastSentIndex: number): Promise<void> {
  const dir = join(dataDir, "cursors");
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${cursorId}.json.tmp`);
  const final = join(dir, `${cursorId}.json`);
  await writeFile(
    tmp,
    JSON.stringify({ lastSentIndex, updatedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  // Atomic replace so a crashed write never corrupts the cursor file.
  await rename(tmp, final);
}

async function handleSearch(args: string[], client: GatewayClient): Promise<string> {
  const query = args.join(" ").trim();
  if (!query) return "Usage: /memory-search <query>";
  const result = await client.searchMemories(query, { limit: 10 });
  return result.results || "No memories found.";
}

/**
 * Read the query from stdin instead of argv. Used by the memory-search skill
 * to avoid the cc `$ARGUMENTS` literal-replaceAll RCE surface (see Anthropic
 * GH issue #16163) — when the query rides on stdin it never touches a shell
 * word-split or expansion stage.
 */
async function handleSearchStdin(rawStdin: string, client: GatewayClient): Promise<string> {
  const query = rawStdin.trim();
  if (!query) return "Usage: pipe the query to stdin";
  const result = await client.searchMemories(query, { limit: 10 });
  return result.results || "No memories found.";
}

async function handleStatus(client: GatewayClient): Promise<string> {
  const ok = await client.health();
  const dataDir = resolveDataDir();
  const hookLog = join(dataDir, "hook.log");
  const daemonLog = join(dataDir, "daemon.log");
  const header = ok ? "TDAI memory daemon: healthy" : "TDAI memory daemon: unreachable";
  return `${header}\nhook log:   ${hookLog}\ndaemon log: ${daemonLog}`;
}

async function handleClearSession(data: HookStdin, client: GatewayClient): Promise<string> {
  const cwd = data.cwd ?? process.cwd();
  const sessionKey = getSessionKey(cwd);
  await client.sessionEnd(sessionKey);
  return `Cleared session buffer for: ${sessionKey}`;
}

// ============================================================================
// L0 jsonl direct search (last-resort fallback)
// ============================================================================

interface L0JsonlRecord {
  sessionKey?: string;
  role?: string;
  content?: string;
  recordedAt?: string;
}

async function searchL0JsonlDirect(
  convDir: string,
  query: string,
  sessionKey: string,
  limit: number,
): Promise<string> {
  let files: string[];
  try {
    files = (await readdir(convDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return "";
  }
  if (files.length === 0) return "";

  // Sort by mtime desc so newer conversations are scanned first. Filename
  // ordering used to assume "YYYY-MM-DD.jsonl" naming, which broke for any
  // other scheme (e.g. cc transcript UUIDs).
  const withMtime = await Promise.all(
    files.map(async (f) => {
      try {
        const st = await stat(join(convDir, f));
        return { name: f, mtime: st.mtimeMs };
      } catch {
        return { name: f, mtime: 0 };
      }
    }),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  const sortedFiles = withMtime.map((e) => e.name);

  // CJK 2-gram tokens, sans a small stop set. The previous list stopped
  // common content-bearing pronouns ("我们/你们/这个/可以/有没/没有" etc.)
  // which silently shredded recall for everyday Chinese queries — keep only
  // genuinely low-signal interrogative / connective fragments here.
  const CJK_STOP = new Set([
    "之前", "前聊", "聊的", "还记", "记得", "得么", "得吗",
    "一下", "怎么", "什么", "关于", "知道", "以前", "上次",
    "如何", "为何", "为啥", "哪里", "哪些", "为什",
    "请问", "请帮", "帮我", "麻烦",
  ]);
  const keywords: string[] = [];
  for (const seg of query.toLowerCase().replace(/[^\w一-鿿]/g, " ").split(/\s+/)) {
    if (!seg) continue;
    if (/[一-鿿]/.test(seg)) {
      for (let i = 0; i <= seg.length - 2; i++) {
        const gram = seg.slice(i, i + 2);
        if (!CJK_STOP.has(gram)) keywords.push(gram);
      }
    } else if (seg.length >= 2) {
      keywords.push(seg);
    }
  }
  if (keywords.length === 0) return "";

  type Match = { role: string; content: string; recordedAt: string; hits: number };
  const matches: Match[] = [];
  const seen = new Set<string>();

  for (const f of sortedFiles) {
    // Stream the file line-by-line: large jsonl (multi-MB) used to be
    // readFile'd into memory in full, which OOM'd on long-running sessions.
    let rl;
    try {
      rl = createInterface({
        input: createReadStream(join(convDir, f), { encoding: "utf-8" }),
        crlfDelay: Infinity,
      });
    } catch {
      continue;
    }
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as L0JsonlRecord;
          if (rec.sessionKey !== sessionKey) continue;
          const text = rec.content ?? "";
          const textLower = text.toLowerCase();
          const hits = keywords.filter((kw) => textLower.includes(kw)).length;
          if (hits === 0) continue;
          // Deduplicate identical content (e.g. repeated user prompts).
          const fingerprint = text.slice(0, 120);
          if (seen.has(fingerprint)) continue;
          seen.add(fingerprint);
          matches.push({
            role: rec.role ?? "unknown",
            content: text.length > 2000 ? text.slice(0, 2000) + "…" : text,
            recordedAt: rec.recordedAt ?? "",
            hits,
          });
        } catch {
          // skip malformed lines
        }
      }
    } finally {
      rl.close();
    }
  }

  if (matches.length === 0) return "";

  // Rank: assistant messages first (more informative than user prompts),
  // then by keyword hits (desc), then content length (desc).
  const rolePriority = (r: string) => (r === "assistant" ? 1 : 0);
  matches.sort(
    (a, b) =>
      rolePriority(b.role) - rolePriority(a.role) ||
      b.hits - a.hits ||
      b.content.length - a.content.length,
  );

  const selected = matches.slice(0, limit);
  const lines = [`Found ${selected.length} matching conversation(s):`, ""];
  for (const m of selected) {
    lines.push("---");
    lines.push(`**[${m.role}]** ${m.recordedAt}`);
    lines.push("");
    lines.push(m.content);
    lines.push("");
  }
  return `## Past conversations (relevant to current prompt)\n\n${lines.join("\n")}`;
}

// ============================================================================
// CLI entry — only runs when this file is executed directly via `node hook.js`
// ============================================================================

async function main(): Promise<void> {
  const event = (process.argv[2] ?? "") as HookEvent;
  const args = process.argv.slice(3);

  const dataDir = resolveDataDir();
  const logPath = join(dataDir, "hook.log");

  try {
    const stdin = await readStdin();

    const mgr = new DaemonManager({ dataDir });
    let state = await readDaemonState(dataDir);

    if (event === "session-start") {
      // A stale state.json (dead pid / unreachable port) used to wedge the
      // daemon forever: the old `!state` guard only spawned when state was
      // ABSENT, so a leftover file meant ensureRunning never ran and every
      // recall/capture hit ECONNREFUSED. Probe the recorded daemon; if it
      // doesn't answer /health, drop the stale state and respawn fresh.
      //
      // Exception: an externally-managed gateway (ccPid <= 0, owned by
      // start-gateway.ps1) is NEVER cleared or respawned when it's
      // temporarily unreachable. Clearing it would let ensureRunning spawn a
      // session-bound daemon that overwrites the operator's state.json and
      // then self-exits when this cc session ends (the Windows failure mode
      // this model was built to avoid). Leave it; the operator restarts it.
      if (state && state.ccPid > 0 && !(await mgr.probe())) {
        await safeLog(
          logPath,
          `session-start: stale daemon state (pid=${state.pid} port=${state.port}) unreachable — clearing and respawning`,
        );
        await clearDaemonState(dataDir);
        state = null;
      }
      if (!state) {
        try {
          state = await mgr.ensureRunning(process.ppid);
        } catch (err) {
          await safeLog(logPath, `session-start: spawn failed: ${(err as Error).message}`);
        }
      }
    }

    if (!state) {
      await safeLog(logPath, `${event}: no daemon, skipped`);
      return;
    }

    const token = await mgr.readToken(state.tokenPath);
    const client = new GatewayClient({
      baseUrl: `http://127.0.0.1:${state.port}`,
      token,
      timeoutMs: event === "user-prompt-submit" ? 4_000 : 10_000,
      logPath,
    });

    const out = await handleHook(event, { stdin, client, args });
    if (out) process.stdout.write(out);
  } catch (err) {
    await safeLog(logPath, `${event}: ${(err as Error).message}`);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", () => resolve(""));
  });
}

async function safeLog(path: string, msg: string): Promise<void> {
  try {
    await appendFile(path, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // ignore
  }
}

// Cross-platform main-module detection. The previous `file://${argv[1]}`
// string never matched import.meta.url on Windows (drive-letter path with
// backslashes vs a proper file:/// URL), so main() silently never ran.
const isMainModule =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(() => process.exit(0));
}
