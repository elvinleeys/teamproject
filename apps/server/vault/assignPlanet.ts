// 행성 자동 배정 (POLICY 2-3 키워드 규칙, SPEC 3-2).
// ① 도메인 → ② 확장자 → ③ 키워드가 가장 많이 맞은 행성 → 동점이면 만든 순서. 아무것도 안 맞으면 미분류.
import type { PlanetKeywords } from "./db.ts";

export interface AssignInput {
  name?: string | null; // 파일 이름 (확장자 제외)
  ext?: string | null; // "pptx"
  domain?: string | null; // 링크 도메인 (경로·검색어는 쓰지 않는다)
  text?: string | null; // 텍스트 본문 (앞 2,000자만 본다)
}

export interface AssignPlanet {
  id: string;
  name: string;
  keywords: PlanetKeywords;
}

const TEXT_HEAD = 2000;
const HANGUL = /[가-힣]/;

/** 한글 키워드는 부분 일치, 영문은 단어 단위 일치 ("mail"에서 "ai"를 찾지 않는다) */
function matches(haystack: string, keyword: string): boolean {
  const k = keyword.toLowerCase();
  if (!k) return false;
  if (HANGUL.test(k)) return haystack.includes(k);
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(haystack);
}

const domainMatches = (domain: string, d: string) => domain === d || domain.endsWith(`.${d}`);

/** planets는 만든 순서. 미분류(키워드 없음)는 fallbackId로 받는다 */
export function assignPlanet(planets: AssignPlanet[], input: AssignInput, fallbackId: string): string {
  const domain = input.domain?.toLowerCase().replace(/^www\./, "");
  if (domain) {
    const hit = planets.find((p) => p.keywords.domains.some((d) => domainMatches(domain, d)));
    if (hit) return hit.id;
  }
  const ext = input.ext?.toLowerCase();
  if (ext) {
    const hit = planets.find((p) => p.keywords.exts.includes(ext));
    if (hit) return hit.id;
  }
  const haystack = [input.name, input.text?.slice(0, TEXT_HEAD)].filter(Boolean).join("\n").toLowerCase();
  if (!haystack) return fallbackId;
  let best: { id: string; score: number } | null = null;
  for (const p of planets) {
    if (p.id === fallbackId) continue;
    // 행성 이름도 키워드다 (사용자가 만든 "토익" 같은 행성)
    const score = [...new Set([p.name, ...p.keywords.words])].filter((k) => matches(haystack, k)).length;
    if (score > 0 && (!best || score > best.score)) best = { id: p.id, score };
  }
  return best?.id ?? fallbackId;
}
