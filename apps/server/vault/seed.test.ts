import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { inPeriod, todayPeriod, weekPeriod } from "@spacelog/shared/period";
import { getTodayPick } from "../routes/rediscovery.ts";
import { openVault } from "./db.ts";
import { seedDemo } from "./seed.ts";

process.env.TZ = "Asia/Seoul";

function check(now: Date) {
  const v = openVault(mkdtempSync(join(tmpdir(), "spacelog-seed-")), () => now);
  const stars = seedDemo(v, now);
  assert.equal(stars.length, 23);
  assert.ok(stars.every((s) => new Date(s.createdAtUtc) <= now), "미래 시각 없음");
  assert.equal(stars.filter((s) => inPeriod(s.createdAtUtc, weekPeriod(now), now)).length, 20, "이번 주 20개");
  assert.ok(stars.filter((s) => inPeriod(s.createdAtUtc, todayPeriod(now), now)).length >= 6, "오늘 6개 이상");
  assert.equal(new Set(stars.map((s) => s.planetId)).size, 4, "행성 4곳");

  const pick = getTodayPick(v, now);
  assert.equal(pick?.daysAgo, 7, "재발견이 뜬다");
  assert.throws(() => seedDemo(v, now), /이미 별이 있는/);
  v.close();
}

describe("데모 시드", () => {
  it("데모 날(수요일 오후): 이번 주 20개·오늘 6개·7일 전 3개", () => check(new Date("2026-11-11T05:00:00Z")));
  it("월요일 0시 직후에 넣어도 이번 주 20개가 지난주로 새지 않는다", () => check(new Date("2026-11-09T15:40:00Z")));
});
