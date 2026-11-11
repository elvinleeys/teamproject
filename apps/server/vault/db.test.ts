import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { periodUtcBounds } from "@spacelog/shared/period";
import type { Star } from "@spacelog/shared/types";
import { getTodayPick } from "../routes/rediscovery.ts";
import { openVault, ulid, UNCATEGORIZED_ID } from "./db.ts";

process.env.TZ = "Asia/Seoul";
const NOW = new Date("2026-11-11T03:00:00Z"); // KST 11-11 12:00

function star(id: string, createdAtUtc: string, over: Partial<Star> = {}): Star {
  return {
    id, kind: "text", planetId: UNCATEGORIZED_ID, createdAtUtc, tzOffsetMin: 540, updatedAtUtc: createdAtUtc, storagePath: null,
    originalName: null, mimeType: null, sizeBytes: null, sha256: null, url: null, linkTitle: null, linkDomain: null,
    textBody: `본문 ${id}`, thumbnailPath: null, thumbnailStatus: "fallback", linkFetchStatus: "none", memo: null, ...over,
  };
}

const tempVault = () => mkdtempSync(join(tmpdir(), "spacelog-vault-"));

describe("보관함 DB", () => {
  it("처음 열면 폴더와 기본 행성 7개를 만들고, 다시 열어도 늘지 않는다", () => {
    const dir = tempVault();
    mkdirSync(join(dir, "tmp"));
    writeFileSync(join(dir, "tmp", "half-copied.bin"), "x");

    const v = openVault(dir, () => NOW);
    for (const sub of ["originals", "thumbnails", "tmp", "archive.db"]) assert.ok(existsSync(join(dir, sub)), sub);
    assert.ok(!existsSync(join(dir, "tmp", "half-copied.bin")), "tmp는 비운다");

    const planets = v.listPlanets();
    assert.deepEqual(planets.map((p) => p.name), ["업무", "공부", "개발", "디자인", "읽을거리", "생활", "미분류"]);
    assert.equal(planets.at(-1)!.id, UNCATEGORIZED_ID);
    assert.equal(planets.at(-1)!.system, "uncategorized");
    assert.equal(new Set(planets.map((p) => p.colorToken)).size, 7);
    assert.ok(!("keywords" in planets[0]), "키워드는 API로 내보내지 않는다");
    assert.ok(v.listPlanetKeywords()[2].keywords.domains.includes("github.com"));
    v.close();

    const again = openVault(dir);
    assert.equal(again.listPlanets().length, 7);
    again.close();
  });

  it("별을 넣고 그대로 꺼낸다", () => {
    const v = openVault(tempVault(), () => NOW);
    const s = star(ulid(NOW.getTime()), "2026-11-11T01:00:00Z", { memo: "메모", tzOffsetMin: 0 });
    v.insertStar(s);
    assert.deepEqual(v.getStar(s.id), s);
    assert.equal(v.getStar("없음"), null);
    assert.throws(() => v.insertStar(star("x", "2026-11-11T01:00:00Z", { planetId: "없는 행성" })), /FOREIGN KEY/);
    v.close();
  });

  it("기간 조회는 현지 날짜 경계를 따른다 (periodUtcBounds)", () => {
    const v = openVault(tempVault(), () => NOW);
    v.insertStar(star("a", "2026-11-09T14:59:59Z")); // KST 11-09 23:59
    v.insertStar(star("b", "2026-11-09T15:00:00Z")); // KST 11-10 00:00
    v.insertStar(star("c", "2026-11-10T14:59:59Z")); // KST 11-10 23:59
    v.insertStar(star("d", "2026-11-11T02:00:00Z")); // 오늘
    v.insertStar(star("e", "2026-11-12T00:00:00Z")); // 미래 시각 → 오늘에 들어간다

    const ids = (from: string, to: string) => {
      const { startUtc, endUtc } = periodUtcBounds({ preset: "custom", from, to }, NOW);
      return v.listStarsBetween(startUtc, endUtc).map((s) => s.id);
    };
    assert.deepEqual(ids("2026-11-10", "2026-11-10"), ["b", "c"]);
    assert.deepEqual(ids("2026-11-11", "2026-11-11"), ["d", "e"]);
    assert.deepEqual(ids("2026-11-09", "2026-11-11"), ["a", "b", "c", "d", "e"]);
    v.close();
  });

  it("재발견 저장소로 그대로 쓴다: 7일 전 별을 고르고 같은 날은 같은 픽", () => {
    const v = openVault(tempVault(), () => NOW);
    v.insertStar(star("week-ago", "2026-11-04T03:00:00Z"));
    v.insertStar(star("today", "2026-11-11T01:00:00Z"));

    const first = getTodayPick(v, NOW);
    assert.equal(first?.star.id, "week-ago");
    assert.equal(first?.daysAgo, 7);
    assert.deepEqual(v.getPick("2026-11-11")?.starId, "week-ago");
    assert.deepEqual(v.pickedStarIds("2026-10-12", "2026-11-12"), ["week-ago"]);
    assert.equal(getTodayPick(v, NOW)?.star.id, "week-ago");

    v.addEvent({ id: "e1", localDate: "2026-11-11", starId: "week-ago", channel: "card", type: "shown", atUtc: NOW.toISOString() });
    v.close();
  });

  it("ULID는 26자이고 시각 순으로 정렬된다", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    assert.equal(a.length, 26);
    assert.ok(a < b);
  });
});
