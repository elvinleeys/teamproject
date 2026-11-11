// 보관함 DB (SPEC 2-7): {vaultDir}/archive.db + originals/ · thumbnails/ · tmp/.
// node:sqlite(Node 24 내장)를 쓴다. 컬럼 이름 = Star·Planet 필드 이름이라 행을 그대로 돌려준다.
// routes/의 RediscoveryRepo(#7)·ExportRepo(#8)·UniverseRepo를 그대로 구현한다 (index.ts에서 연결).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Planet, RediscoveryEvent, RediscoveryPick, Star } from "@spacelog/shared/types";
import { readTextHead, vaultFilePath } from "../export/readText.ts";
import type { PickCandidate } from "../rediscovery/pick.ts";

export const DB_FILE = "archive.db";
export const UNCATEGORIZED_ID = "planet_uncategorized";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 앞 10자 = 밀리초 시각, 뒤 16자 = 무작위. 같은 시각 안의 순서는 보장하지 않는다 */
export function ulid(timeMs: number = Date.now()): string {
  let time = "";
  for (let t = timeMs, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  let rand = "";
  for (const b of randomBytes(16)) rand += CROCKFORD[b % 32];
  return time + rand;
}

/** 행성 자동 배정 키워드 (POLICY 2-3 표). API에는 내보내지 않는다 (SPEC 2-2) */
export interface PlanetKeywords {
  words: string[];
  domains: string[];
  exts: string[];
}

/** 첫 실행 때 만드는 기본 행성 7개. 순서 = 동점일 때 고르는 순서 */
export const DEFAULT_PLANETS: { name: string; keywords: PlanetKeywords }[] = [
  {
    name: "업무",
    keywords: {
      words: ["회의", "회의록", "보고서", "기획", "제안서", "견적", "계약", "일정", "업무", "주간보고", "결재", "발표", "meeting", "minutes", "report", "proposal", "plan", "invoice", "kpi", "okr"],
      domains: ["notion.so", "slack.com", "docs.google.com", "drive.google.com", "atlassian.net", "office.com"],
      exts: ["ppt", "pptx", "xls", "xlsx"],
    },
  },
  {
    name: "공부",
    keywords: {
      words: ["강의", "과제", "시험", "요약", "강의노트", "필기", "수업", "스터디", "논문", "레포트", "자격증", "기출", "lecture", "study", "exam", "assignment", "course", "paper", "notes"],
      domains: ["inflearn.com", "coursera.org", "udemy.com", "arxiv.org", "scholar.google.com", "riss.kr", "dbpia.co.kr", "wikipedia.org"],
      exts: ["hwp", "hwpx"],
    },
  },
  {
    name: "개발",
    keywords: {
      words: ["소스코드", "에러", "오류", "버그", "배포", "서버", "함수", "code", "error", "bug", "api", "deploy", "react", "python", "sql", "docker", "git"],
      domains: ["github.com", "stackoverflow.com", "velog.io", "developer.mozilla.org", "npmjs.com"],
      exts: ["py", "js", "ts", "json", "sql", "log"],
    },
  },
  {
    name: "디자인",
    keywords: {
      words: ["디자인", "레퍼런스", "시안", "무드보드", "로고", "폰트", "색상", "아이콘", "design", "reference", "moodboard", "ui", "ux", "logo", "font", "palette"],
      domains: ["figma.com", "behance.net", "dribbble.com", "pinterest.com", "mobbin.com"],
      exts: ["fig", "psd", "ai", "sketch"],
    },
  },
  {
    name: "읽을거리",
    keywords: {
      words: ["뉴스", "아티클", "칼럼", "블로그", "영상", "인터뷰", "나중에", "article", "news", "blog", "video"],
      domains: ["youtube.com", "youtu.be", "medium.com", "brunch.co.kr", "blog.naver.com"],
      exts: [],
    },
  },
  {
    name: "생활",
    keywords: {
      words: ["여행", "맛집", "예약", "쇼핑", "영수증", "레시피", "항공권", "숙소", "주문", "travel", "recipe", "receipt", "order"],
      domains: ["coupang.com", "musinsa.com", "map.naver.com", "airbnb.co.kr"],
      exts: [],
    },
  },
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS planets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  system TEXT,
  colorToken TEXT NOT NULL,
  createdAtUtc TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '{"words":[],"domains":[],"exts":[]}'
);
CREATE UNIQUE INDEX IF NOT EXISTS planets_name ON planets (name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS stars (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('image','file','link','text')),
  planetId TEXT NOT NULL REFERENCES planets(id),
  createdAtUtc TEXT NOT NULL,
  tzOffsetMin INTEGER NOT NULL,
  updatedAtUtc TEXT NOT NULL,
  storagePath TEXT,
  originalName TEXT,
  mimeType TEXT,
  sizeBytes INTEGER,
  sha256 TEXT,
  url TEXT,
  linkTitle TEXT,
  linkDomain TEXT,
  textBody TEXT,
  thumbnailPath TEXT,
  thumbnailStatus TEXT NOT NULL,
  linkFetchStatus TEXT NOT NULL,
  memo TEXT
);
CREATE INDEX IF NOT EXISTS stars_created ON stars (createdAtUtc);
CREATE INDEX IF NOT EXISTS stars_planet ON stars (planetId);
CREATE INDEX IF NOT EXISTS stars_sha256 ON stars (sha256);

CREATE TABLE IF NOT EXISTS rediscovery_picks (
  localDate TEXT PRIMARY KEY,
  starId TEXT,
  daysAgo INTEGER,
  pickedAtUtc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rediscovery_events (
  id TEXT PRIMARY KEY,
  localDate TEXT NOT NULL,
  starId TEXT NOT NULL,
  channel TEXT NOT NULL,
  type TEXT NOT NULL,
  atUtc TEXT NOT NULL
);
`;

const STAR_COLUMNS = [
  "id", "kind", "planetId", "createdAtUtc", "tzOffsetMin", "updatedAtUtc", "storagePath", "originalName", "mimeType",
  "sizeBytes", "sha256", "url", "linkTitle", "linkDomain", "textBody", "thumbnailPath", "thumbnailStatus", "linkFetchStatus", "memo",
] as const satisfies readonly (keyof Star)[];

const PLANET_SELECT = "SELECT id, name, system, NULL AS defaultFor, colorToken, createdAtUtc FROM planets ORDER BY createdAtUtc, rowid";

// node:sqlite 행은 프로토타입이 없는 객체라 평범한 객체로 바꾼다
const plain = <T>(row: unknown): T => ({ ...(row as object) }) as T;

export type Vault = ReturnType<typeof openVault>;

/** 보관함 폴더·DB를 열고, 처음이면 기본 행성을 만든다. tmp/는 비운다 (SPEC 2-7) */
export function openVault(vaultDir: string, now: () => Date = () => new Date()) {
  for (const dir of ["originals", "thumbnails"]) mkdirSync(join(vaultDir, dir), { recursive: true });
  rmSync(join(vaultDir, "tmp"), { recursive: true, force: true });
  mkdirSync(join(vaultDir, "tmp"));

  const db = new DatabaseSync(join(vaultDir, DB_FILE));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  const insertPlanet = db.prepare(
    "INSERT INTO planets (id, name, system, colorToken, createdAtUtc, keywords) VALUES (:id, :name, :system, :colorToken, :createdAtUtc, :keywords)",
  );
  if (!db.prepare("SELECT 1 FROM planets LIMIT 1").get()) {
    const at = now();
    const all = [...DEFAULT_PLANETS.map((p) => ({ ...p, id: ulid(at.getTime()), system: null })),
      { name: "미분류", keywords: { words: [], domains: [], exts: [] }, id: UNCATEGORIZED_ID, system: "uncategorized" }];
    db.exec("BEGIN");
    all.forEach((p, i) =>
      insertPlanet.run({ id: p.id, name: p.name, system: p.system, colorToken: `planet-${i + 1}`, createdAtUtc: at.toISOString(), keywords: JSON.stringify(p.keywords) }),
    );
    db.exec("COMMIT");
  }

  const insertStarStmt = db.prepare(`INSERT INTO stars (${STAR_COLUMNS.join(", ")}) VALUES (${STAR_COLUMNS.map((c) => `:${c}`).join(", ")})`);
  const getStarStmt = db.prepare("SELECT * FROM stars WHERE id = ?");
  const allStarsStmt = db.prepare("SELECT * FROM stars ORDER BY createdAtUtc, id");
  const starsSinceStmt = db.prepare("SELECT * FROM stars WHERE createdAtUtc >= ? ORDER BY createdAtUtc, id");
  const starsBetweenStmt = db.prepare("SELECT * FROM stars WHERE createdAtUtc >= ? AND createdAtUtc < ? ORDER BY createdAtUtc, id");
  const planetsStmt = db.prepare(PLANET_SELECT);
  const keywordsStmt = db.prepare("SELECT id, name, keywords FROM planets ORDER BY createdAtUtc, rowid");

  const vault = {
    vaultDir,
    db,

    insertStar(star: Star): void {
      insertStarStmt.run(Object.fromEntries(STAR_COLUMNS.map((c) => [c, star[c] ?? null])));
    },
    getStar(id: string): Star | null {
      const row = getStarStmt.get(id);
      return row ? plain<Star>(row) : null;
    },
    listStars(): Star[] {
      return allStarsStmt.all().map((r) => plain<Star>(r));
    },
    /** startUtc <= createdAtUtc < endUtc. endUtc가 null이면 상한 없음 (period.ts periodUtcBounds) */
    listStarsBetween(startUtc: string, endUtc: string | null): Star[] {
      const rows = endUtc === null ? starsSinceStmt.all(startUtc) : starsBetweenStmt.all(startUtc, endUtc);
      return rows.map((r) => plain<Star>(r));
    },
    listPlanets(): Planet[] {
      return planetsStmt.all().map((r) => plain<Planet>(r));
    },
    countStarsByPlanet(): Record<string, number> {
      const rows = db.prepare("SELECT planetId, COUNT(*) AS n FROM stars GROUP BY planetId").all();
      return Object.fromEntries(rows.map((r) => [String(r.planetId), Number(r.n)]));
    },
    /** 원본이 있어야 하는 별(storagePath 있음)인데 보관함에 파일이 없으면 true */
    originalMissing(star: Star): boolean {
      if (!star.storagePath) return false;
      const file = vaultFilePath(vaultDir, star.storagePath);
      return !file || !existsSync(file);
    },
    /** 자동 배정용 (만든 순서). 미분류 포함 */
    listPlanetKeywords(): { id: string; name: string; keywords: PlanetKeywords }[] {
      return keywordsStmt.all().map((r) => ({ id: String(r.id), name: String(r.name), keywords: JSON.parse(String(r.keywords)) }));
    },
    readFileText(star: Star): string | null {
      return readTextHead(vaultDir, star.storagePath);
    },

    // ── RediscoveryRepo ──
    listPickCandidates(): PickCandidate[] {
      return db.prepare("SELECT id, createdAtUtc FROM stars").all().map((r) => plain<PickCandidate>(r));
    },
    getPick(localDate: string): RediscoveryPick | null {
      const row = db.prepare("SELECT * FROM rediscovery_picks WHERE localDate = ?").get(localDate);
      return row ? plain<RediscoveryPick>(row) : null;
    },
    savePick(pick: RediscoveryPick): void {
      db.prepare("INSERT OR REPLACE INTO rediscovery_picks (localDate, starId, daysAgo, pickedAtUtc) VALUES (:localDate, :starId, :daysAgo, :pickedAtUtc)").run({ ...pick });
    },
    pickedStarIds(fromLocalDate: string, toLocalDate: string): string[] {
      return db
        .prepare("SELECT starId FROM rediscovery_picks WHERE localDate >= ? AND localDate < ? AND starId IS NOT NULL")
        .all(fromLocalDate, toLocalDate)
        .map((r) => String(r.starId));
    },
    addEvent(e: RediscoveryEvent): void {
      db.prepare("INSERT INTO rediscovery_events (id, localDate, starId, channel, type, atUtc) VALUES (:id, :localDate, :starId, :channel, :type, :atUtc)").run({ ...e });
    },

    close(): void {
      db.close();
    },
  };
  return vault;
}
