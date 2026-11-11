import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assignPlanet, type AssignPlanet } from "./assignPlanet.ts";
import { DEFAULT_PLANETS, UNCATEGORIZED_ID } from "./db.ts";

const planets: AssignPlanet[] = [
  ...DEFAULT_PLANETS.map((p) => ({ id: p.name, name: p.name, keywords: p.keywords })),
  { id: "토익", name: "토익", keywords: { words: [], domains: [], exts: [] } },
  { id: UNCATEGORIZED_ID, name: "미분류", keywords: { words: [], domains: [], exts: [] } },
];
const assign = (input: Parameters<typeof assignPlanet>[1]) => assignPlanet(planets, input, UNCATEGORIZED_ID);

describe("행성 자동 배정 (POLICY 2-3)", () => {
  it("도메인 → 확장자 → 키워드 개수 순", () => {
    assert.equal(assign({ domain: "m.youtube.com" }), "읽을거리", "하위 도메인");
    assert.equal(assign({ domain: "www.github.com" }), "개발");
    assert.equal(assign({ name: "강의 요약", ext: "pptx" }), "업무", "확장자가 키워드보다 먼저");
    assert.equal(assign({ name: "강의노트 시험 요약 회의" }), "공부", "키워드가 더 많이 맞은 행성");
  });

  it("한글은 부분 일치, 영문은 단어 단위", () => {
    assert.equal(assign({ name: "회의록2" }), "업무");
    assert.equal(assign({ text: "mail draft" }), UNCATEGORIZED_ID, "mail에서 ai를 찾지 않는다");
    assert.equal(assign({ text: "React hooks 정리" }), "개발");
  });

  it("행성 이름도 키워드, 동점이면 만든 순서, 안 맞으면 미분류", () => {
    assert.equal(assign({ name: "토익 단어장" }), "토익");
    assert.equal(assign({ text: "회의 강의" }), "업무", "1:1 동점 → 먼저 만든 업무");
    assert.equal(assign({ name: "IMG_2041" }), UNCATEGORIZED_ID);
    assert.equal(assign({}), UNCATEGORIZED_ID);
  });
});
