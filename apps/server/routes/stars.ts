// 기록 넣기 (SPEC 2-6, 3-2). 수집 앱이 부른다.
//   POST /api/stars  multipart 필드 "files" (최대 20개)  또는  JSON { kind: "text", text } | { kind: "link", url }
//   → CreateStarsResponse. 일부만 실패해도 나머지는 저장한다 (P 3-3)
//   PATCH /api/stars  { ids, planetId?, memo? } → { stars }. 넣은 직후 확인 카드 일괄 적용 (SPEC 2-6)
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { localDate } from "@spacelog/shared/period";
import type { CreateStarsResponse, StarsResponse } from "@spacelog/shared/types";
import type { RouteHandler } from "../app.ts";
import { isObject, readJson } from "../http/body.ts";
import { RouteError } from "../http/routeError.ts";
import type { Vault } from "../vault/db.ts";
import { ingestFiles, ingestLink, ingestText, type IncomingFile } from "../vault/ingest.ts";

// shortcut: multipart를 메모리에 다 받은 뒤 처리한다(Request.formData). 요청 전체 상한으로 막는다.
// 200MB 파일 여러 개를 자주 넣게 되면 스트리밍 파서(busboy 등)로 바꾼다
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
/** 10만 자 넘는 텍스트도 .txt로 저장하므로 JSON은 넉넉히 받는다 */
export const MAX_TEXT_BODY_BYTES = 20 * 1024 * 1024;

async function readFiles(req: IncomingMessage): Promise<IncomingFile[]> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) throw RouteError.badRequest("업로드가 너무 커요");
  let size = 0;
  let tooBig = false;
  async function* capped() {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_UPLOAD_BYTES) {
        tooBig = true;
        throw new Error("too big");
      }
      yield chunk as Buffer;
    }
  }
  let form: FormData;
  try {
    form = await new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": String(req.headers["content-type"]) },
      body: Readable.toWeb(Readable.from(capped())),
      duplex: "half",
    } as RequestInit).formData();
  } catch {
    throw RouteError.badRequest(tooBig ? "업로드가 너무 커요" : "multipart 형식이 아니에요");
  }
  const files: IncomingFile[] = [];
  for (const v of form.getAll("files")) {
    if (typeof v === "string") continue;
    files.push({ name: v.name || null, type: v.type || null, bytes: Buffer.from(await v.arrayBuffer()) });
  }
  if (files.length === 0) throw RouteError.badRequest("files가 없어요");
  return files;
}

export async function createStars(vault: Vault, req: IncomingMessage, now: Date): Promise<CreateStarsResponse> {
  if (String(req.headers["content-type"] ?? "").startsWith("multipart/form-data")) {
    return ingestFiles(vault, await readFiles(req), now);
  }
  const body = await readJson(req, MAX_TEXT_BODY_BYTES);
  if (isObject(body) && body.kind === "text" && typeof body.text === "string") return ingestText(vault, body.text, now);
  if (isObject(body) && body.kind === "link" && typeof body.url === "string") {
    const r = ingestLink(vault, body.url, now);
    if (r) return r;
    throw RouteError.badRequest("url이 http(s) 주소가 아니에요");
  }
  throw RouteError.badRequest('본문은 { kind: "text", text } 또는 { kind: "link", url } 이어야 해요');
}

/** 수집 앱 확인 카드 메모 상한 (types.ts BulkUpdateStarsRequest) */
export const CONFIRM_MEMO_MAX = 140;
/** 한 번에 넣는 파일이 20개라 확인 카드도 그 이하지만, 여유 있게 받는다 */
const MAX_BULK_IDS = 100;

export async function bulkUpdateStars(vault: Vault, req: IncomingMessage, now: Date): Promise<StarsResponse> {
  const body = await readJson(req, 64 * 1024);
  if (!isObject(body)) throw RouteError.badRequest("본문이 객체가 아니에요");
  const { ids, planetId, memo } = body;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK_IDS || !ids.every((id) => typeof id === "string" && id)) {
    throw RouteError.badRequest("ids가 올바르지 않아요");
  }
  if (planetId !== undefined && typeof planetId !== "string") throw RouteError.badRequest("planetId가 문자열이 아니에요");
  if (memo !== undefined && memo !== null && (typeof memo !== "string" || memo.length > CONFIRM_MEMO_MAX)) {
    throw RouteError.badRequest(`memo는 ${CONFIRM_MEMO_MAX}자 이하 문자열이어야 해요`);
  }
  if (planetId !== undefined && !vault.planetExists(planetId)) throw RouteError.of("NOT_FOUND");
  const change = { planetId: planetId as string | undefined, memo: memo === undefined ? undefined : (memo as string | null) || null };
  const stars = vault.updateStars(ids as string[], change, now.toISOString());
  if (!stars) throw RouteError.of("NOT_FOUND");
  return { stars: stars.map((s) => ({ ...s, localDate: localDate(s.createdAtUtc, now), originalMissing: vault.originalMissing(s) })) };
}

export function starRoutes(vault: Vault, deps: { now?: () => Date } = {}): Record<string, RouteHandler> {
  const now = deps.now ?? (() => new Date());
  return {
    "POST /api/stars": (req) => createStars(vault, req, now()),
    "PATCH /api/stars": (req) => bulkUpdateStars(vault, req, now()),
  };
}
