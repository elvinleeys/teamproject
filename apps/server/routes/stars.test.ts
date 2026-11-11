import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import type { CreateStarsResponse } from "@spacelog/shared/types";
import { routes, startServer } from "../app.ts";
import { openVault, UNCATEGORIZED_ID, type Vault } from "../vault/db.ts";
import { MAX_FILES, MAX_TEXT_CHARS } from "../vault/ingest.ts";
import { mountRoutes } from "./mount.ts";
import { starRoutes } from "./stars.ts";

process.env.TZ = "Asia/Seoul";
const NOW = new Date("2026-11-11T05:00:00Z");
const TOKEN = "stars-test";

describe("POST /api/stars", () => {
  let vault: Vault;
  let server: Server;
  let port: number;
  let unmount: () => void;

  before(async () => {
    vault = openVault(mkdtempSync(join(tmpdir(), "spacelog-stars-")), () => NOW);
    unmount = mountRoutes(routes, starRoutes(vault, { now: () => NOW }));
    ({ server, port } = await startServer({ token: TOKEN, basePort: 0, webDir: null, devOrigin: null, vaultDir: null }));
  });
  after(() => {
    unmount();
    server.close();
    vault.close();
  });

  // 수집 앱(스파이크)과 같은 방식: fetch + FormData / JSON
  const post = async (body: FormData | object) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/stars`, {
      method: "POST",
      headers: body instanceof FormData ? { "x-session-token": TOKEN } : { "x-session-token": TOKEN, "content-type": "application/json" },
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as CreateStarsResponse };
  };
  const form = (...files: [string, string, string][]) => {
    const f = new FormData();
    for (const [name, type, content] of files) f.append("files", new Blob([content], { type }), name);
    return f;
  };

  it("파일을 원본으로 복사하고 행성을 배정한다, 같은 내용은 중복으로 돌려준다", async () => {
    const { status, json } = await post(form(["주간보고.pptx", "application/vnd.ms-powerpoint", "slides"], ["shot.png", "image/png", "png-bytes"]));
    assert.equal(status, 200);
    assert.equal(json.created.length, 2);
    const [ppt, png] = json.created;
    assert.equal(ppt.kind, "file");
    assert.equal(png.kind, "image");
    assert.equal(ppt.planetId, vault.listPlanets().find((p) => p.name === "업무")!.id);
    assert.match(ppt.storagePath!, /^originals\/2026\/11\/[0-9A-Z]{26}\.pptx$/);
    assert.equal(readFileSync(join(vault.vaultDir, ppt.storagePath!), "utf8"), "slides");
    assert.equal(ppt.localDate, "2026-11-11");
    assert.deepEqual(vault.getStar(ppt.id)?.sha256, ppt.sha256);

    const again = await post(form(["복사본.pptx", "", "slides"]));
    assert.equal(again.json.created.length, 0);
    assert.deepEqual(again.json.duplicates, [{ name: "복사본.pptx", existingStarId: ppt.id, planetId: ppt.planetId, planetName: "업무" }]);
  });

  it(`${MAX_FILES + 1}번째 파일부터는 거부하고 나머지는 저장한다`, async () => {
    const files = Array.from({ length: MAX_FILES + 2 }, (_, i) => [`f${i}.bin`, "", `unique-${i}`] as [string, string, string]);
    const { json } = await post(form(...files));
    assert.equal(json.created.length, MAX_FILES);
    assert.deepEqual(json.rejected.map((r) => r.code), ["TOO_MANY_FILES", "TOO_MANY_FILES"]);
  });

  it("텍스트·링크", async () => {
    const text = await post({ kind: "text", text: "React 배포 에러 메모" });
    assert.equal(text.json.created[0].textBody, "React 배포 에러 메모");
    assert.equal(text.json.created[0].planetId, vault.listPlanets().find((p) => p.name === "개발")!.id);

    const link = await post({ kind: "link", url: "https://www.figma.com/file/abc?x=1" });
    assert.equal(link.json.created[0].kind, "link");
    assert.equal(link.json.created[0].linkDomain, "figma.com");
    assert.equal(link.json.created[0].planetId, vault.listPlanets().find((p) => p.name === "디자인")!.id);

    const empty = await post({ kind: "text", text: "   " });
    assert.deepEqual(empty.json.rejected.map((r) => r.code), ["TEXT_EMPTY"]);
  });

  it(`${MAX_TEXT_CHARS.toLocaleString()}자 넘는 텍스트는 .txt 파일 기록`, async () => {
    const { json } = await post({ kind: "text", text: "가".repeat(MAX_TEXT_CHARS + 1) });
    const s = json.created[0];
    assert.equal(s.kind, "file");
    assert.equal(s.textBody, null);
    assert.equal(s.planetId, UNCATEGORIZED_ID);
    assert.ok(s.storagePath!.endsWith(".txt") && existsSync(join(vault.vaultDir, s.storagePath!)));
  });

  it("틀린 요청은 INVALID_REQUEST", async () => {
    for (const body of [{ kind: "link", url: "javascript:alert(1)" }, { kind: "image" }, new FormData()]) {
      const { status, json } = await post(body);
      assert.equal(status, 400);
      assert.equal((json as unknown as { error: { code: string } }).error.code, "INVALID_REQUEST");
    }
  });
});
