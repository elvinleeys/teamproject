// 재발견 라우트 (SPEC 3-6, POLICY 2-2, 이슈 #7).
//   GET  /api/rediscovery/today   → { star, daysAgo } | null
//   POST /api/rediscovery/events  → null (기록만)
// 저장소는 인터페이스로 받는다. DB(개발 B, #4 2/4)가 이 인터페이스를 구현하면 연결만 하면 된다.
import { randomUUID } from "node:crypto";
import { addDays, localDate, toLocalDateString } from "@spacelog/shared/period";
import type { RediscoveryEvent, RediscoveryPick, RediscoveryTodayResponse, Star } from "@spacelog/shared/types";
import type { RouteHandler } from "../app.ts";
import { isObject, readJson } from "../http/body.ts";
import { RouteError } from "../http/routeError.ts";
import { pickToday, type PickCandidate } from "../rediscovery/pick.ts";

/** "최근 30일 안에 픽된 별은 뺀다" (SPEC 3-6) */
export const RECENT_PICK_DAYS = 30;

export interface RediscoveryRepo {
  /** 픽 후보: 모든 별의 id와 넣은 시각 */
  listPickCandidates(): PickCandidate[];
  getStar(id: string): Star | null;
  getPick(localDate: string): RediscoveryPick | null;
  savePick(pick: RediscoveryPick): void;
  /** localDate가 [from, to) 인 픽의 starId (null 제외) */
  pickedStarIds(fromLocalDate: string, toLocalDate: string): string[];
  addEvent(event: RediscoveryEvent): void;
}

export interface RediscoveryDeps {
  now?: () => Date;
  newId?: () => string;
}

const CHANNELS = ["notification", "card"] as const;
const TYPES = ["shown", "opened", "dismissed"] as const;

/**
 * 오늘의 픽. 그날 처음 조회할 때 정해 저장하고, 같은 날에는 저장된 픽을 그대로 돌려준다 (알림과 카드가 같은 별).
 * 픽된 별이 그날 삭제되면 다시 고르지 않고 null.
 */
export function getTodayPick(repo: RediscoveryRepo, now: Date): RediscoveryTodayResponse {
  const today = toLocalDateString(now);
  let pick = repo.getPick(today);
  if (!pick) {
    const recent = repo.pickedStarIds(addDays(today, -RECENT_PICK_DAYS), today);
    const chosen = pickToday({ stars: repo.listPickCandidates(), recentPickedStarIds: recent, now });
    pick = { localDate: today, starId: chosen?.starId ?? null, daysAgo: chosen?.daysAgo ?? null, pickedAtUtc: now.toISOString() };
    repo.savePick(pick);
  }
  if (!pick.starId || !pick.daysAgo) return null;
  const star = repo.getStar(pick.starId);
  // /api/universe와 같이 현지 날짜를 채워 준다 (PR #46 리뷰 1)
  return star ? { star: { ...star, localDate: localDate(star.createdAtUtc, now) }, daysAgo: pick.daysAgo } : null;
}

/** 본문 검사: { starId, channel, type } */
export function parseEventBody(body: unknown): Pick<RediscoveryEvent, "starId" | "channel" | "type"> {
  if (!isObject(body)) throw RouteError.badRequest("본문이 객체가 아니에요");
  const { starId, channel, type } = body;
  if (typeof starId !== "string" || !starId) throw RouteError.badRequest("starId가 없어요");
  if (!CHANNELS.includes(channel as (typeof CHANNELS)[number])) throw RouteError.badRequest("channel이 올바르지 않아요");
  if (!TYPES.includes(type as (typeof TYPES)[number])) throw RouteError.badRequest("type이 올바르지 않아요");
  return { starId, channel: channel as RediscoveryEvent["channel"], type: type as RediscoveryEvent["type"] };
}

export function rediscoveryRoutes(repo: RediscoveryRepo, deps: RediscoveryDeps = {}): Record<string, RouteHandler> {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  return {
    "GET /api/rediscovery/today": () => getTodayPick(repo, now()),
    "POST /api/rediscovery/events": async (req) => {
      const body = parseEventBody(await readJson(req, 4 * 1024));
      if (!repo.getStar(body.starId)) throw RouteError.of("NOT_FOUND"); // 없는 별 이벤트는 저장하지 않는다 (PR #46 리뷰 2)
      const at = now();
      repo.addEvent({ id: newId(), localDate: toLocalDateString(at), atUtc: at.toISOString(), ...body });
      return null;
    },
  };
}
