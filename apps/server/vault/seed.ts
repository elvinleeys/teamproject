// 데모 시드 (DEMO 1장 사전 준비, #33): 7일 전 별 3개(재발견용) + 이번 주 별 20개, 행성 4곳에 나눠 넣는다.
// 실행: node apps/server/vault/seed.ts <보관함 폴더>
// 이미 별이 있는 보관함에는 넣지 않는다 (사용자 기록과 섞이지 않게). 새 폴더를 쓰거나 지우고 다시 실행한다.
import { addDays, parseLocalDate, toLocalDateString, weekPeriod } from "@spacelog/shared/period";
import type { Star } from "@spacelog/shared/types";
import { openVault, ulid, type Vault } from "./db.ts";

type Seed = { planet: string; text?: string; url?: string; title?: string };

/** 7일 전 (재발견 후보). 데모 4~5분: "7일 전 오늘의 별" */
const WEEK_AGO: Seed[] = [
  { planet: "디자인", url: "https://www.figma.com/community/file/onboarding-moodboard", title: "온보딩 무드보드 레퍼런스" },
  { planet: "공부", text: "강의노트: 3D 좌표계 — 카메라는 lookAt으로, 행성 궤도는 반지름·각속도로 정한다." },
  { planet: "업무", text: "회의록: 데모 동선은 드롭 → 저장 → 우주 → 재발견 → 탐사선 순서로 간다." },
];

/** 이번 주 20개. 뒤쪽 6개가 오늘 */
const THIS_WEEK: Seed[] = [
  { planet: "업무", text: "주간보고 초안: 수집 앱 드롭존 완성, 서버 보관함 DB 연결." },
  { planet: "업무", url: "https://www.notion.so/spacelog/sprint-plan", title: "스프린트 기획" },
  { planet: "업무", text: "발표 준비: 3분 데모 + 질의응답 2분. 시연 PC 해상도 확인." },
  { planet: "업무", url: "https://docs.google.com/presentation/d/demo-deck", title: "데모 발표 자료" },
  { planet: "업무", text: "회의: 행성 자동 배정은 키워드 규칙으로 확정 (Q1)." },
  { planet: "공부", url: "https://www.inflearn.com/course/threejs-basics", title: "Three.js 기초 강의" },
  { planet: "공부", text: "스터디 요약: SQLite WAL 모드는 읽기와 쓰기가 서로 막지 않는다." },
  { planet: "공부", url: "https://arxiv.org/abs/2106.09685", title: "논문: LoRA" },
  { planet: "공부", text: "과제: 망각 곡선 정리 — 7일·14일·30일 간격 복습이 기억 유지에 효과적." },
  { planet: "공부", text: "시험 범위: 운영체제 4~7장, 기출 2회분 풀기." },
  { planet: "개발", url: "https://github.com/nodejs/node/blob/main/doc/api/sqlite.md", title: "node:sqlite 문서" },
  { planet: "개발", text: "에러 메모: EADDRINUSE → 포트 +1씩 최대 10번 재시도로 해결." },
  { planet: "개발", url: "https://stackoverflow.com/questions/three-js-orbit-controls", title: "OrbitControls 질문" },
  { planet: "개발", text: "배포 체크: 서명 없는 exe는 앱 제어 정책에 막힘 → 개발 모드로 데모." },
  { planet: "개발", url: "https://developer.mozilla.org/docs/Web/API/WebGL_API", title: "WebGL API" },
  { planet: "디자인", url: "https://dribbble.com/shots/space-dashboard", title: "우주 대시보드 시안" },
  { planet: "디자인", text: "색상 토큰: planet-1~7, 배경은 깊은 남색, 별은 따뜻한 흰색." },
  { planet: "디자인", url: "https://www.behance.net/gallery/space-ui", title: "우주 UI 레퍼런스" },
  { planet: "디자인", text: "폰트 후보: Pretendard 본문, 제목은 자간 -2%." },
  { planet: "디자인", url: "https://mobbin.com/browse/web/flows/onboarding", title: "온보딩 플로우 모음" },
];

const TODAY_COUNT = 6;
const HOUR = 3_600_000;

function toStar(seed: Seed, at: Date, planetId: string): Star {
  const createdAtUtc = at.toISOString();
  const link = seed.url ? new URL(seed.url) : null;
  return {
    id: ulid(at.getTime()),
    kind: link ? "link" : "text",
    planetId,
    createdAtUtc,
    tzOffsetMin: -at.getTimezoneOffset(),
    updatedAtUtc: createdAtUtc,
    storagePath: null,
    originalName: null,
    mimeType: null,
    sizeBytes: null,
    sha256: null,
    url: seed.url ?? null,
    linkTitle: seed.title ?? null,
    linkDomain: link ? link.hostname.replace(/^www\./, "") : null,
    textBody: seed.text ?? null,
    thumbnailPath: null,
    thumbnailStatus: "fallback",
    linkFetchStatus: link ? "done" : "none",
    memo: null,
  };
}

/** 시각을 정해 넣는다. 미래 시각은 만들지 않는다 */
export function seedDemo(vault: Vault, now: Date = new Date()): Star[] {
  if (vault.listStars().length > 0) throw new Error("이미 별이 있는 보관함이에요. 빈 폴더에 시드를 넣어 주세요");
  const planetId = new Map(vault.listPlanets().map((p) => [p.name, p.id]));
  const idOf = (name: string) => planetId.get(name) ?? (() => { throw new Error(`행성이 없어요: ${name}`); })();

  const today = toLocalDateString(now);
  const weekAgoStart = parseLocalDate(addDays(today, -7)).getTime();
  const weekStart = parseLocalDate(weekPeriod(now).from).getTime();
  const todayStart = parseLocalDate(today).getTime();

  const times: number[] = [
    ...WEEK_AGO.map((_, i) => weekAgoStart + (10 + i * 3) * HOUR), // 7일 전 10시·13시·16시
  ];
  // 이번 주 앞쪽 14개: 월요일 00:00 ~ 오늘 00:00 사이 고르게 (오늘이 월요일이면 오늘 0시 ~ 지금 사이)
  const earlyCount = THIS_WEEK.length - TODAY_COUNT;
  const earlyEnd = todayStart > weekStart ? todayStart : Math.max(weekStart, now.getTime() - (TODAY_COUNT + 1) * 5 * 60_000);
  for (let i = 0; i < earlyCount; i++) times.push(weekStart + Math.floor(((earlyEnd - weekStart) * (i + 0.5)) / earlyCount));
  // 오늘 6개: 지금부터 5분 간격으로 거슬러 (오늘 0시보다 앞서지 않게)
  for (let i = TODAY_COUNT; i >= 1; i--) times.push(Math.max(todayStart, now.getTime() - i * 5 * 60_000));

  const stars = [...WEEK_AGO, ...THIS_WEEK].map((s, i) => toStar(s, new Date(times[i]), idOf(s.planet)));
  vault.db.exec("BEGIN");
  try {
    stars.forEach((s) => vault.insertStar(s));
    vault.db.exec("COMMIT");
  } catch (err) {
    vault.db.exec("ROLLBACK");
    throw err;
  }
  return stars;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("사용법: node apps/server/vault/seed.ts <보관함 폴더>");
    process.exit(1);
  }
  const vault = openVault(dir);
  try {
    const stars = seedDemo(vault);
    const today = toLocalDateString(new Date());
    const weekAgo = addDays(today, -7);
    const count = (d: string) => stars.filter((s) => toLocalDateString(new Date(s.createdAtUtc)) === d).length;
    console.log(`별 ${stars.length}개를 넣었어요. 7일 전(${weekAgo}) ${count(weekAgo)}개 · 오늘 ${count(today)}개`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    vault.close();
  }
}
