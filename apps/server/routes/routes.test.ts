import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Planet, RediscoveryEvent, RediscoveryPick, Star } from "@spacelog/shared/types";
import { routes, startServer } from "../app.ts";
import { FILE_TEXT_LIMIT } from "../export/collect.ts";
import { readTextHead, vaultFilePath } from "../export/readText.ts";
import { RouteError } from "../http/routeError.ts";
import { exportRoutes, parseExportBody, type ExportRepo } from "./export.ts";
import { mountRoutes } from "./mount.ts";
import { getTodayPick, parseEventBody, rediscoveryRoutes, type RediscoveryRepo } from "./rediscovery.ts";

process.env.TZ = "Asia/Seoul";
const NOW = new Date("2026-11-11T03:00:00Z"); // KST 11-11 12:00
const TOKEN = "routes-test-token";

function star(id: string, createdAtUtc: string, over: Partial<Star> = {}): Star {
  return {
    id, kind: "text", planetId: "p1", createdAtUtc, tzOffsetMin: 540, updatedAtUtc: createdAtUtc, storagePath: null,
    originalName: null, mimeType: null, sizeBytes: null, sha256: null, url: null, linkTitle: null, linkDomain: null,
    textBody: `본문 ${id}`, thumbnailPath: null, thumbnailStatus: "ready", linkFetchStatus: "none", memo: null, ...over,
  } as Star;
}
const planet = { id: "p1", name: "공부", system: null, colorToken: "planet-1", createdAtUtc: "2026-11-01T00:00:00Z" } as Planet;

/** 메모리 저장소 (DB 대신) */
class MemoryRepo implements RediscoveryRepo, ExportRepo {
  stars = new Map<string, Star>();
  picks = new Map<string, RediscoveryPick>();
  events: RediscoveryEvent[] = [];
  constructor(stars: Star[]) {
    stars.forEach((s) => this.stars.set(s.id, s));
  }
  listPickCandidates = () => [...this.stars.values()].map(({ id, createdAtUtc }) => ({ id, createdAtUtc }));
  getStar = (id: string) => this.stars.get(id) ?? null;
  getPick = (d: string) => this.picks.get(d) ?? null;
  savePick = (p: RediscoveryPick) => void this.picks.set(p.localDate, p);
  pickedStarIds = (from: string, to: string) =>
    [...this.picks.values()].filter((p) => p.localDate >= from && p.localDate < to && p.starId).map((p) => p.starId!);
  addEvent = (e: RediscoveryEvent) => void this.events.push(e);
  listStars = () => [...this.stars.values()];
  listPlanets = () => [planet];
  readFileText = () => null;
}

describe("재발견 today", () => {
  it("그날 처음 조회할 때 픽을 저장하고, 같은 날 다시 조회하면 같은 별", () => {
    const repo = new MemoryRepo([star("a", "2026-11-04T03:00:00Z"), star("b", "2026-11-04T04:00:00Z")]);
    const first = getTodayPick(repo, NOW);
    assert.equal(first?.daysAgo, 7);
    repo.stars.set("c", star("c", "2026-11-04T05:00:00Z")); // 후보가 늘어도
    assert.equal(getTodayPick(repo, NOW)?.star.id, first?.star.id);
    assert.equal(repo.picks.size, 1);
  });

  it("후보가 없으면 null을 저장하고 그날은 다시 고르지 않는다", () => {
    const repo = new MemoryRepo([]);
    assert.equal(getTodayPick(repo, NOW), null);
    assert.deepEqual(repo.picks.get("2026-11-11")?.starId, null);
    repo.stars.set("late", star("late", "2026-11-04T03:00:00Z"));
    assert.equal(getTodayPick(repo, NOW), null);
  });

  it("픽된 별이 삭제되면 null (다시 고르지 않음)", () => {
    const repo = new MemoryRepo([star("a", "2026-11-04T03:00:00Z"), star("b", "2026-11-04T04:00:00Z")]);
    const id = getTodayPick(repo, NOW)!.star.id;
    repo.stars.delete(id);
    assert.equal(getTodayPick(repo, NOW), null);
  });

  it("최근 30일 안에 픽된 별은 뺀다", () => {
    const repo = new MemoryRepo([star("a", "2026-11-04T03:00:00Z"), star("b", "2026-10-28T03:00:00Z")]);
    repo.savePick({ localDate: "2026-11-01", starId: "a", daysAgo: 7, pickedAtUtc: "" });
    assert.deepEqual(getTodayPick(repo, NOW), { star: { ...repo.getStar("b"), localDate: "2026-10-28" }, daysAgo: 14 });
  });
});

describe("재발견 events 본문 검사", () => {
  it("올바른 본문", () => {
    assert.deepEqual(parseEventBody({ starId: "a", channel: "card", type: "shown" }), { starId: "a", channel: "card", type: "shown" });
  });
  it("틀린 본문은 400", () => {
    for (const bad of [null, [], { starId: "", channel: "card", type: "shown" }, { starId: "a", channel: "email", type: "shown" }, { starId: "a", channel: "card", type: "clicked" }]) {
      assert.throws(() => parseEventBody(bad), (e: unknown) => e instanceof RouteError && e.status === 400);
    }
  });
});

describe("내보내기 본문 검사", () => {
  const period = { preset: "today", from: "2026-11-11", to: "2026-11-11" };
  it("세 종류 cargo와 형식", () => {
    const body = { format: "mcp", items: [{ type: "star", starId: "a" }, { type: "planet", planetId: "p1", period }, { type: "universe", period }] };
    assert.equal(parseExportBody(body).items.length, 3);
  });
  it("형식·항목·기간이 틀리면 400, 너무 많으면 400", () => {
    const bads = [
      { format: "pdf", items: [] },
      { format: "claude", items: "x" },
      { format: "claude", items: [{ type: "galaxy" }] },
      { format: "claude", items: [{ type: "universe", period: { ...period, from: "11/11" } }] },
      { format: "claude", items: Array.from({ length: 501 }, () => ({ type: "star", starId: "a" })) },
    ];
    for (const bad of bads) assert.throws(() => parseExportBody(bad), (e: unknown) => e instanceof RouteError && e.status === 400);
  });
});

describe(".md 원본 읽기", () => {
  const vault = mkdtempSync(join(tmpdir(), "spacelog-vault-"));
  mkdirSync(join(vault, "originals"));
  writeFileSync(join(vault, "originals", "note.md"), "가".repeat(FILE_TEXT_LIMIT + 50));

  it("보관함 밖 경로는 읽지 않는다", () => {
    assert.equal(vaultFilePath(vault, "../secret.txt"), null);
    assert.equal(vaultFilePath(vault, "/etc/passwd"), null);
    assert.equal(readTextHead(vault, "../secret.txt"), null);
    assert.equal(readTextHead(vault, null), null);
    assert.equal(readTextHead(vault, "originals/none.md"), null);
  });
  it("앞부분만 읽고, 자르기 판단용으로 한 글자 이상 더 읽는다", () => {
    const text = readTextHead(vault, "originals/note.md")!;
    assert.ok(text.length > FILE_TEXT_LIMIT);
    assert.ok(!text.includes("�"));
  });
});

describe("서버에 붙여 HTTP로 호출", () => {
  let server: Server;
  let port: number;
  let unmount: () => void;
  const repo = new MemoryRepo([star("a", "2026-11-04T03:00:00Z")]);

  before(async () => {
    unmount = mountRoutes(routes, { ...rediscoveryRoutes(repo, { now: () => NOW, newId: () => "ev1" }), ...exportRoutes(repo, { now: () => NOW }) });
    ({ server, port } = await startServer({ token: TOKEN, basePort: 0, webDir: null, devOrigin: null, vaultDir: null }));
  });
  after(() => {
    server.close();
    unmount();
  });

  function call(method: string, path: string, body?: string) {
    return new Promise<{ status: number; body: string }>((ok, fail) => {
      const headers: Record<string, string> = { host: `127.0.0.1:${port}`, "x-session-token": TOKEN };
      if (body !== undefined) headers["content-type"] = "application/json";
      const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => ok({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", fail);
      req.end(body);
    });
  }

  it("GET today → 별과 daysAgo", async () => {
    const res = await call("GET", "/api/rediscovery/today");
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.star.id, "a");
    assert.equal(json.daysAgo, 7);
  });

  it("POST events → 기록, 틀린 본문은 400 INVALID_REQUEST", async () => {
    const ok = await call("POST", "/api/rediscovery/events", JSON.stringify({ starId: "a", channel: "card", type: "opened" }));
    assert.equal(ok.status, 200);
    assert.deepEqual(repo.events[0], { id: "ev1", localDate: "2026-11-11", atUtc: NOW.toISOString(), starId: "a", channel: "card", type: "opened" });
    const bad = await call("POST", "/api/rediscovery/events", "{not json");
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.body).error.code, "INVALID_REQUEST");
    const ghost = await call("POST", "/api/rediscovery/events", JSON.stringify({ starId: "없는 별", channel: "card", type: "shown" }));
    assert.equal(ghost.status, 404, "없는 별 이벤트는 저장하지 않는다");
    assert.equal(repo.events.length, 1);
  });

  it("POST export → Claude 프롬프트", async () => {
    const res = await call("POST", "/api/export", JSON.stringify({ format: "claude", items: [{ type: "star", starId: "a" }] }));
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.match(json.content, /<planet name="공부">/);
    assert.equal(json.overLimit, false);
  });

  it("같은 라우트를 두 번 붙이면 던진다", () => {
    assert.throws(() => mountRoutes(routes, rediscoveryRoutes(repo)), /이미 있어요/);
  });
});
