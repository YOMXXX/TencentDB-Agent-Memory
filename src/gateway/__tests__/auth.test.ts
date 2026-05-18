import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import http from "node:http";
import { TdaiGateway } from "../server.js";

async function request(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{ status: number; body: string; wwwAuth: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
            wwwAuth: res.headers["www-authenticate"] as string | undefined,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Gateway optional Bearer token", () => {
  let gateway: TdaiGateway;
  const PORT = 18421;
  const TOKEN = "test-token-abc-123";

  beforeAll(async () => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", TOKEN);
    gateway = new TdaiGateway({
      server: { port: PORT, host: "127.0.0.1" },
    } as never);
    await gateway.start();
  });

  // vitest config has `unstubEnvs: true`, which resets stubs before each test.
  // Re-stub here so the middleware (which reads process.env per-request) sees the token.
  beforeEach(() => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", TOKEN);
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it("rejects unauthenticated requests with 401 when token is configured", async () => {
    const res = await request(PORT, "/health");
    expect(res.status).toBe(401);
  });

  it("rejects wrong token with 401", async () => {
    const res = await request(PORT, "/health", {
      Authorization: "Bearer wrong-token",
    });
    expect(res.status).toBe(401);
  });

  it("accepts correct Bearer token", async () => {
    const res = await request(PORT, "/health", {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(200);
  });

  it("includes WWW-Authenticate header on 401 per RFC 6750 §3", async () => {
    const res = await request(PORT, "/health");
    expect(res.status).toBe(401);
    expect(res.wwwAuth).toMatch(/^Bearer\s+realm=/);
  });

  it("accepts case-insensitive 'Bearer' scheme keyword per RFC 6750 §2.1", async () => {
    for (const scheme of ["Bearer", "bearer", "BEARER", "BeArEr"]) {
      const res = await request(PORT, "/health", {
        Authorization: `${scheme} ${TOKEN}`,
      });
      expect(res.status, `scheme=${scheme}`).toBe(200);
    }
  });

  it("rejects mangled Authorization headers", async () => {
    const cases = [
      `Basic ${TOKEN}`,
      `Bearer`,
      `Bearer `,
      `Bearer  ${TOKEN}  extra`,
      ``,
      `Bearer ${TOKEN}x`,
      `Bearer x${TOKEN}`,
    ];
    for (const h of cases) {
      const res = await request(PORT, "/health", { Authorization: h });
      expect(res.status, `auth=${JSON.stringify(h)}`).toBe(401);
    }
  });

  it.each([
    ["POST", "/recall"],
    ["POST", "/capture"],
    ["POST", "/search/memories"],
    ["POST", "/search/conversations"],
    ["POST", "/session/end"],
    ["POST", "/seed"],
  ])("enforces auth on %s %s (no token → 401)", async (method, path) => {
    const res = await request(PORT, path, {}, method);
    expect(res.status).toBe(401);
  });

  it("OPTIONS without CORS enabled does NOT bypass Bearer auth", async () => {
    // The legacy behavior — `Access-Control-Allow-Origin: *` hardcoded and
    // OPTIONS returning 204 unconditionally — let any unauthenticated
    // client probe the daemon (and worse, combine with DNS rebinding).
    // CORS is now opt-in: an OPTIONS request without TDAI_GATEWAY_CORS_ORIGIN
    // is treated like any other and must pass auth.
    return new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: PORT,
          path: "/recall",
          method: "OPTIONS",
        },
        (res) => {
          expect(res.statusCode).toBe(401);
          resolve();
        },
      );
      req.on("error", reject);
      req.end();
    });
  });
});

describe("Gateway with no token configured", () => {
  let gateway: TdaiGateway;
  const PORT = 18422;

  beforeAll(async () => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
    gateway = new TdaiGateway({
      server: { port: PORT, host: "127.0.0.1" },
    } as never);
    await gateway.start();
  });

  // vitest config has `unstubEnvs: true`; re-stub each test so middleware sees empty token.
  beforeEach(() => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it("accepts unauthenticated requests when token is empty (backward compat)", async () => {
    const res = await request(PORT, "/health");
    expect(res.status).toBe(200);
  });
});

describe("Gateway CORS is opt-in (TDAI_GATEWAY_CORS_ORIGIN)", () => {
  let gateway: TdaiGateway;
  const PORT = 18423;

  beforeAll(async () => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
    gateway = new TdaiGateway({
      server: { port: PORT, host: "127.0.0.1" },
    } as never);
    await gateway.start();
  });

  beforeEach(() => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it("does NOT emit Access-Control-Allow-Origin by default", async () => {
    const res = await requestWithHeaders(PORT, "/health");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-headers"]).toBeUndefined();
    expect(res.headers["access-control-allow-methods"]).toBeUndefined();
  });

  it("does NOT respond 204 to OPTIONS preflight when CORS is disabled", async () => {
    const res = await requestWithHeaders(PORT, "/recall", {}, "OPTIONS");
    // With CORS disabled, OPTIONS should fall through to normal routing
    // (404 because OPTIONS /recall is not a defined route), NOT a 204 preflight ack.
    expect(res.status).not.toBe(204);
  });

  it("emits Access-Control-Allow-Origin: <value> when TDAI_GATEWAY_CORS_ORIGIN is set", async () => {
    vi.stubEnv("TDAI_GATEWAY_CORS_ORIGIN", "https://example.com");
    const res = await requestWithHeaders(PORT, "/health");
    expect(res.headers["access-control-allow-origin"]).toBe("https://example.com");
  });

  it("returns 204 for OPTIONS preflight when CORS is enabled", async () => {
    vi.stubEnv("TDAI_GATEWAY_CORS_ORIGIN", "https://example.com");
    const res = await requestWithHeaders(PORT, "/recall", {}, "OPTIONS");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://example.com");
  });
});

describe("Gateway Host header allowlist (defence against DNS rebinding)", () => {
  let gateway: TdaiGateway;
  const PORT = 18424;

  beforeAll(async () => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
    gateway = new TdaiGateway({
      server: { port: PORT, host: "127.0.0.1" },
    } as never);
    await gateway.start();
  });

  beforeEach(() => {
    vi.stubEnv("TDAI_GATEWAY_TOKEN", "");
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it.each([
    "127.0.0.1",
    "127.0.0.1:8421",
    "localhost",
    "localhost:8421",
    "[::1]",
    "[::1]:8421",
  ])("accepts loopback Host: %s", async (hostHeader) => {
    const res = await requestWithHeaders(PORT, "/health", { Host: hostHeader });
    expect(res.status, `Host=${hostHeader}`).toBe(200);
  });

  it.each([
    "evil.com",
    "evil.com:8421",
    "10.0.0.1",
    "example.com",
    "127.0.0.1.evil.com",
    "localhost.evil.com",
  ])("rejects non-loopback Host: %s with 403", async (hostHeader) => {
    const res = await requestWithHeaders(PORT, "/health", { Host: hostHeader });
    expect(res.status, `Host=${hostHeader}`).toBe(403);
  });

  it("skips Host check when TDAI_GATEWAY_ALLOW_REMOTE=1", async () => {
    vi.stubEnv("TDAI_GATEWAY_ALLOW_REMOTE", "1");
    const res = await requestWithHeaders(PORT, "/health", { Host: "evil.com" });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Helper: same as `request` above but returns all response headers so we can
// assert CORS/Host behavior. Kept separate to avoid mutating `request`'s API
// the existing Bearer tests rely on.
// ---------------------------------------------------------------------------

async function requestWithHeaders(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
