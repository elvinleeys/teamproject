// 기록 넣기 (SPEC 3-2, POLICY 2-6): 종류 판별 → SHA-256 중복 검사 → tmp/에 쓰고 originals/로 옮김 → DB 저장.
// DB 저장이 실패하면 옮긴 원본을 지운다. 썸네일·링크 제목 가져오기는 하지 않는다 (데모 범위 밖, #33).
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatErrorMessage, type ErrorCode } from "@spacelog/shared/errors";
import { localDate, toLocalDateString } from "@spacelog/shared/period";
import type { CreateStarsResponse, Star } from "@spacelog/shared/types";
import { assignPlanet, type AssignInput } from "./assignPlanet.ts";
import { UNCATEGORIZED_ID, ulid, type Vault } from "./db.ts";

export const MAX_FILE_BYTES = 200 * 1024 * 1024; // P 2-6 (잠정)
export const MAX_FILES = 20;
export const MAX_TEXT_CHARS = 100_000; // 넘으면 .txt 파일 기록으로

export interface IncomingFile {
  name: string | null;
  type: string | null;
  bytes: Buffer;
}

type Result = CreateStarsResponse;
type RejectCode = Result["rejected"][number]["code"];

export const emptyResult = (): Result => ({ created: [], duplicates: [], rejected: [] });

function reject(r: Result, name: string | null, code: RejectCode): void {
  r.rejected.push({ name, code, message: formatErrorMessage(code as ErrorCode) });
}

/** "보고서.final.PPTX" → { base: "보고서.final", ext: "pptx" }. 이상한 확장자는 버린다 */
function splitName(name: string | null): { base: string | null; ext: string | null } {
  if (!name) return { base: null, ext: null };
  const m = /^(.*)\.([A-Za-z0-9]{1,10})$/.exec(name);
  return m && m[1] ? { base: m[1], ext: m[2].toLowerCase() } : { base: name, ext: null };
}

function newStar(vault: Vault, now: Date, fields: Partial<Star> & Pick<Star, "kind">, assign: AssignInput): Star {
  const at = now.toISOString();
  return {
    id: ulid(now.getTime()),
    planetId: assignPlanet(vault.listPlanetKeywords(), assign, UNCATEGORIZED_ID),
    createdAtUtc: at,
    tzOffsetMin: -now.getTimezoneOffset(),
    updatedAtUtc: at,
    storagePath: null, originalName: null, mimeType: null, sizeBytes: null, sha256: null,
    url: null, linkTitle: null, linkDomain: null, textBody: null,
    thumbnailPath: null, thumbnailStatus: "fallback", linkFetchStatus: "none", memo: null,
    ...fields,
  };
}

/** 응답용: 조회 때 계산하는 값까지 채운다 */
const withComputed = (s: Star, now: Date): Star => ({ ...s, localDate: localDate(s.createdAtUtc, now), originalMissing: false });

/** 파일 하나를 원본으로 저장. 같은 내용이 이미 있으면 duplicates로 */
function saveFile(vault: Vault, r: Result, file: IncomingFile, now: Date, force: { kind?: Star["kind"]; ext?: string } = {}): void {
  if (file.bytes.length > MAX_FILE_BYTES) return reject(r, file.name, "FILE_TOO_LARGE");
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const existing = vault.findStarBySha256(sha256);
  if (existing) {
    r.duplicates.push({ name: file.name, existingStarId: existing.star.id, planetId: existing.star.planetId, planetName: existing.planetName });
    return;
  }
  const { base, ext: nameExt } = splitName(file.name);
  const ext = force.ext ?? nameExt;
  const mimeType = file.type || null;
  const kind = force.kind ?? (mimeType?.startsWith("image/") ? "image" : "file");
  const star = newStar(vault, now, { kind, originalName: file.name, mimeType, sizeBytes: file.bytes.length, sha256 }, { name: base, ext });
  const [y, m] = toLocalDateString(now).split("-");
  star.storagePath = `originals/${y}/${m}/${star.id}${ext ? `.${ext}` : ""}`;

  const tmp = join(vault.vaultDir, "tmp", star.id);
  const dest = join(vault.vaultDir, star.storagePath);
  try {
    writeFileSync(tmp, file.bytes);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    if ((err as NodeJS.ErrnoException).code === "ENOSPC") return reject(r, file.name, "DISK_FULL");
    throw err;
  }
  try {
    vault.insertStar(star);
  } catch (err) {
    rmSync(dest, { force: true });
    throw err;
  }
  r.created.push(withComputed(star, now));
}

/** multipart 파일들. 21번째부터는 TOO_MANY_FILES (나머지는 저장, P 3-3) */
export function ingestFiles(vault: Vault, files: IncomingFile[], now: Date = new Date()): Result {
  const r = emptyResult();
  files.forEach((f, i) => {
    if (i < MAX_FILES) saveFile(vault, r, f, now);
    else reject(r, f.name, "TOO_MANY_FILES");
  });
  return r;
}

export function ingestText(vault: Vault, text: string, now: Date = new Date()): Result {
  const r = emptyResult();
  if (!text.trim()) {
    reject(r, null, "TEXT_EMPTY");
    return r;
  }
  if (text.length > MAX_TEXT_CHARS) {
    // 이름 없는 .txt 원본 (화면에는 "이름 없는 기록"). 배정은 파일 이름이 없어 미분류로 간다
    saveFile(vault, r, { name: null, type: "text/plain; charset=utf-8", bytes: Buffer.from(text, "utf8") }, now, { kind: "file", ext: "txt" });
    return r;
  }
  const star = newStar(vault, now, { kind: "text", textBody: text }, { text });
  vault.insertStar(star);
  r.created.push(withComputed(star, now));
  return r;
}

/** http(s) URL만 받는다. 아니면 null (호출하는 쪽이 INVALID_REQUEST) */
export function ingestLink(vault: Vault, url: string, now: Date = new Date()): Result | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const linkDomain = parsed.hostname.replace(/^www\./, "");
  const star = newStar(vault, now, { kind: "link", url: parsed.href, linkDomain }, { domain: linkDomain });
  vault.insertStar(star);
  const r = emptyResult();
  r.created.push(withComputed(star, now));
  return r;
}
