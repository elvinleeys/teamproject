// 기간 조회 (SPEC 2-6, 3-3).
//   GET /api/universe?from=YYYY-MM-DD&to=YYYY-MM-DD → { stars, planets }
// 기간 안의 별(localDate·originalMissing 계산) + 모든 행성(기간 안·전체 별 개수). 3D와 목록의 단일 소스.
import { customPeriod, localDate, periodUtcBounds } from "@spacelog/shared/period";
import type { Planet, Star, UniverseResponse } from "@spacelog/shared/types";
import type { RouteHandler } from "../app.ts";
import { RouteError } from "../http/routeError.ts";

export interface UniverseRepo {
  listStarsBetween(startUtc: string, endUtc: string | null): Star[];
  listPlanets(): Planet[];
  /** planetId → 전체 별 개수 */
  countStarsByPlanet(): Record<string, number>;
  /** 원본이 있어야 하는 별인데 보관함에 없으면 true (P 3-4) */
  originalMissing(star: Star): boolean;
}

export function getUniverse(repo: UniverseRepo, from: string, to: string, now: Date): UniverseResponse {
  let period;
  try {
    period = customPeriod(from, to); // 순서 뒤바뀜·1년 초과도 여기서 정리 (P 2-1)
  } catch {
    throw RouteError.badRequest("from·to가 날짜(YYYY-MM-DD)가 아니에요");
  }
  const { startUtc, endUtc } = periodUtcBounds(period, now);
  const stars = repo.listStarsBetween(startUtc, endUtc).map((s) => ({
    ...s,
    localDate: localDate(s.createdAtUtc, now),
    originalMissing: repo.originalMissing(s),
  }));
  const inPeriod: Record<string, number> = {};
  for (const s of stars) inPeriod[s.planetId] = (inPeriod[s.planetId] ?? 0) + 1;
  const total = repo.countStarsByPlanet();
  const planets = repo.listPlanets().map((p) => ({ ...p, starCountInPeriod: inPeriod[p.id] ?? 0, starCountTotal: total[p.id] ?? 0 }));
  return { stars, planets };
}

export function universeRoutes(repo: UniverseRepo, deps: { now?: () => Date } = {}): Record<string, RouteHandler> {
  const now = deps.now ?? (() => new Date());
  return {
    "GET /api/universe": (req) => {
      const q = new URL(req.url ?? "/", "http://localhost").searchParams;
      return getUniverse(repo, q.get("from") ?? "", q.get("to") ?? "", now());
    },
  };
}
