import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { routes, startServer } from "./app.ts";
import { configFromEnv, type ServerConfig } from "./config.ts";
import { DEFAULT_BODY_LIMIT, readJson } from "./http/body.ts";
import { RouteError } from "./http/routeError.ts";
import { resolveStaticPath } from "./static.ts";

const TOKEN = "test-token-1234";

function call(port: number, path: string, headers: Record<string, string> = {}, method = "GET", body?: string) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", fail);
    req.end(body);
  });
}

describe("서버 보안·정적 파일", () => {
  let server: Server;
  let port: number;
  const webDir = mkdtempSync(join(tmpdir(), "spacelog-web-"));
  mkdirSync(join(webDir, "assets"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>SpaceLog</title>");
  writeFileSync(join(webDir, "assets", "app-abc123.js"), "console.log(1)");

  before(async () => {
    const config: ServerConfig = { token: TOKEN, basePort: 0, webDir, devOrigin: "http://localhost:5173", vaultDir: null };
    ({ server, port } = await startServer(config));
  });
  after(() => server.close());

  const auth = { "x-session-token": TOKEN };

  it("토큰이 맞으면 health 200", async () => {
    const r = await call(port, "/api/health", auth);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: true });
  });

  it("토큰이 없거나 틀리면 401 UNAUTHORIZED", async () => {
    const cases: Record<string, string>[] = [{}, { "x-session-token": "wrong" }, { "x-session-token": TOKEN + "x" }];
    for (const h of cases) {
      const r = await call(port, "/api/health", h);
      assert.equal(r.status, 401);
      assert.equal(JSON.parse(r.body).error.code, "UNAUTHORIZED");
    }
  });

  it("다른 Host는 403 (DNS 리바인딩 방어)", async () => {
    const r = await call(port, "/api/health", { ...auth, host: `evil.example:${port}` });
    assert.equal(r.status, 403);
    assert.equal(JSON.parse(r.body).error.code, "FORBIDDEN_ORIGIN");
    assert.equal((await call(port, "/api/health", { ...auth, host: `127.0.0.1:${port + 1}` })).status, 403);
  });

  it("다른 Origin은 403, 자기 Origin·localhost·개발 Origin은 통과", async () => {
    assert.equal((await call(port, "/api/health", { ...auth, origin: "https://evil.example" })).status, 403);
    assert.equal((await call(port, "/api/health", { ...auth, origin: "null" })).status, 403);
    assert.equal((await call(port, "/api/health", { ...auth, origin: `http://127.0.0.1:${port}` })).status, 200);
    assert.equal((await call(port, "/api/health", { ...auth, host: `localhost:${port}`, origin: `http://localhost:${port}` })).status, 200);
    assert.equal((await call(port, "/api/health", { ...auth, origin: "http://localhost:5173" })).status, 200);
  });

  it("다른 Origin은 토큰이 맞아도, 정적 파일이어도 막는다", async () => {
    assert.equal((await call(port, "/", { origin: "https://evil.example" })).status, 403);
  });

  it("CORS 헤더를 보내지 않는다", async () => {
    const r = await call(port, "/api/health", { ...auth, origin: "http://localhost:5173" });
    assert.equal(r.headers["access-control-allow-origin"], undefined);
    assert.equal(r.headers["x-frame-options"], "DENY");
  });

  it("없는 API는 404 NOT_FOUND", async () => {
    const r = await call(port, "/api/nope", auth);
    assert.equal(r.status, 404);
    assert.equal(JSON.parse(r.body).error.code, "NOT_FOUND");
  });

  it("정적 파일은 토큰 없이, index.html은 no-cache, assets는 오래 캐시", async () => {
    const index = await call(port, "/");
    assert.equal(index.status, 200);
    assert.match(String(index.headers["content-type"]), /text\/html/);
    assert.equal(index.headers["cache-control"], "no-cache");
    const js = await call(port, "/assets/app-abc123.js");
    assert.equal(js.status, 200);
    assert.match(String(js.headers["cache-control"]), /immutable/);
  });

  it("보관함 밖 파일은 내려주지 않는다", async () => {
    for (const p of ["/../package.json", "/%2e%2e/package.json", "/assets/%2e%2e%2f%2e%2e%2fpackage.json", "/nope.js"]) {
      assert.equal((await call(port, p)).status, 404, p);
    }
    assert.equal(resolveStaticPath(webDir, "/%00"), null);
    assert.equal(resolveStaticPath(webDir, "/%E0%A4%A"), null);
  });
});

describe("설정·포트", () => {
  it("토큰이 없으면 시작을 거부한다", () => {
    assert.throws(() => configFromEnv({}), /SPACELOG_TOKEN/);
    assert.throws(() => configFromEnv({ SPACELOG_TOKEN: "t", SPACELOG_PORT: "abc" }), /SPACELOG_PORT/);
    assert.deepEqual(configFromEnv({ SPACELOG_TOKEN: "t" }), { token: "t", basePort: 47800, webDir: null, devOrigin: null, vaultDir: null });
  });

  it("개발 Origin이 없으면 Vite 주소도 막는다", async () => {
    const { server, port } = await startServer({ token: TOKEN, basePort: 0, webDir: null, devOrigin: null, vaultDir: null });
    try {
      assert.equal((await call(port, "/api/health", { "x-session-token": TOKEN, origin: "http://localhost:5173" })).status, 403);
    } finally {
      server.close();
    }
  });

  it("포트가 사용 중이면 다음 포트로", async () => {
    const blocker = createServer();
    await new Promise<void>((ok) => blocker.listen(0, "127.0.0.1", ok));
    const taken = (blocker.address() as { port: number }).port;
    try {
      const { server, port } = await startServer({ token: TOKEN, basePort: taken, webDir: null, devOrigin: null, vaultDir: null });
      try {
        assert.ok(port > taken && port < taken + 10, `${port}`);
        assert.equal((await call(port, "/api/health", { "x-session-token": TOKEN })).status, 200);
      } finally {
        server.close();
      }
    } finally {
      blocker.close();
    }
  });
});

describe("라우트·본문", () => {
  let server: Server;
  let port: number;
  const auth = { "x-session-token": TOKEN };
  const added = ["GET /api/test/items/:id", "GET /api/test/items/:id/parts/:part", "POST /api/test/echo", "GET /api/test/fail"];

  before(async () => {
    routes.set(added[0], (_req, p) => ({ id: p.id }));
    routes.set(added[1], (_req, p) => p);
    routes.set(added[2], async (req) => ({ got: await readJson(req) }));
    routes.set(added[3], () => {
      throw RouteError.of("PLANET_SYSTEM");
    });
    ({ server, port } = await startServer({ token: TOKEN, basePort: 0, webDir: null, devOrigin: null, vaultDir: null }));
  });
  after(() => {
    for (const k of added) routes.delete(k);
    server.close();
  });

  it("경로 파라미터를 디코딩해 넘긴다", async () => {
    assert.deepEqual(JSON.parse((await call(port, "/api/test/items/01J%20X", auth)).body), { id: "01J X" });
    assert.deepEqual(JSON.parse((await call(port, "/api/test/items/a/parts/b", auth)).body), { id: "a", part: "b" });
  });

  it("자리 수가 다르거나 비었거나 디코딩이 안 되면 404", async () => {
    for (const p of ["/api/test/items", "/api/test/items/", "/api/test/items/a/b", "/api/test/items/%E0%A4%A"]) {
      assert.equal((await call(port, p, auth)).status, 404, p);
    }
  });

  it("다른 메서드는 404", async () => {
    assert.equal((await call(port, "/api/test/items/a", auth, "DELETE")).status, 404);
  });

  it("JSON 본문을 읽는다", async () => {
    const r = await call(port, "/api/test/echo", { ...auth, "content-type": "application/json" }, "POST", JSON.stringify({ a: "별" }));
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { got: { a: "별" } });
  });

  it("JSON이 아니거나 비었거나 너무 크면 400 INVALID_REQUEST", async () => {
    for (const body of ["{broken", "", "x".repeat(DEFAULT_BODY_LIMIT + 1)]) {
      const r = await call(port, "/api/test/echo", auth, "POST", body);
      assert.equal(r.status, 400);
      assert.equal(JSON.parse(r.body).error.code, "INVALID_REQUEST");
    }
  });

  it("핸들러가 RouteError를 던지면 그 코드로 응답", async () => {
    const r = await call(port, "/api/test/fail", auth);
    assert.equal(r.status, 403);
    assert.equal(JSON.parse(r.body).error.code, "PLANET_SYSTEM");
  });
});
