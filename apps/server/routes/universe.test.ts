import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { UniverseResponse } from "@spacelog/shared/types";
import { routes, startServer } from "../app.ts";
import { RouteError } from "../http/routeError.ts";
import { openVault, UNCATEGORIZED_ID } from "../vault/db.ts";
import { seedDemo } from "../vault/seed.ts";
import { mountRoutes } from "./mount.ts";
import { getUniverse, universeRoutes } from "./universe.ts";

process.env.TZ = "Asia/Seoul";
const NOW = new Date("2026-11-11T05:00:00Z"); // KST 수요일 14:00

function seeded() {
  const v = openVault(mkdtempSync(join(tmpdir(), "spacelog-universe-")), () => NOW);
  seedDemo(v, NOW);
  return v;
}

describe("GET /api/universe", () => {
  it("기간 안의 별과 모든 행성(기간 안·전체 개수)을 돌려준다", () => {
    const v = seeded();
    const week = getUniverse(v, "2026-11-09", "2026-11-11", NOW);
    assert.equal(week.stars.length, 20);
    assert.equal(week.planets.length, 7, "별 없는 행성도 내려준다");
    assert.equal(week.planets.reduce((n, p) => n + p.starCountInPeriod!, 0), 20);
    assert.equal(week.planets.reduce((n, p) => n + p.starCountTotal!, 0), 23, "전체에는 7일 전 별도 센다");
    assert.equal(week.planets.find((p) => p.id === UNCATEGORIZED_ID)!.starCountInPeriod, 0);
    assert.ok(week.stars.every((s) => s.localDate! >= "2026-11-09" && s.originalMissing === false));

    const today = getUniverse(v, "2026-11-11", "2026-11-11", NOW);
    assert.equal(today.stars.length, 6);
    assert.deepEqual(getUniverse(v, "2026-11-11", "2026-11-09", NOW).stars.length, 20, "순서가 뒤바뀌면 맞바꾼다");
    v.close();
  });

  it("원본 파일이 사라진 별은 originalMissing", () => {
    const v = seeded();
    const s = v.listStars()[0];
    assert.equal(v.originalMissing({ ...s, storagePath: "originals/2026/11/없음.png" }), true);
    assert.equal(v.originalMissing({ ...s, storagePath: "../밖.png" }), true, "보관함 밖 경로");
    v.close();
  });

  it("날짜가 아니면 INVALID_REQUEST", () => {
    const v = seeded();
    for (const [from, to] of [["", ""], ["2026-11-11", "어제"], ["2026-02-30", "2026-03-01"]]) {
      assert.throws(() => getUniverse(v, from, to, NOW), (e: unknown) => e instanceof RouteError && e.code === "INVALID_REQUEST");
    }
    v.close();
  });

  it("HTTP로 조회된다", async () => {
    const v = seeded();
    const unmount = mountRoutes(routes, universeRoutes(v, { now: () => NOW }));
    const { server, port } = await startServer({ token: "t", basePort: 0, webDir: null, devOrigin: null, vaultDir: null });
    try {
      const body = await new Promise<{ status: number; json: UniverseResponse }>((ok, fail) => {
        request({ host: "127.0.0.1", port, path: "/api/universe?from=2026-11-11&to=2026-11-11", headers: { "x-session-token": "t" } }, (res) => {
          let d = "";
          res.on("data", (c) => (d += c)).on("end", () => ok({ status: res.statusCode!, json: JSON.parse(d) }));
        }).on("error", fail).end();
      });
      assert.equal(body.status, 200);
      assert.equal(body.json.stars.length, 6);
    } finally {
      unmount();
      server.close();
      v.close();
    }
  });
});
