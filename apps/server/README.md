# 로컬 서버 (개발 B, #4)

## 실행

수집 앱(Electron `utilityProcess`)이 환경 변수로 켠다 (ADR 0001 5장).

| 변수 | 필수 | 뜻 |
| --- | --- | --- |
| `SPACELOG_TOKEN` | ✅ | 세션 토큰. 없으면 시작을 거부한다 |
| `SPACELOG_PORT` | | 시작 포트 (기본 47800). 사용 중이면 +1씩 최대 10번 |
| `SPACELOG_WEB_DIR` | | 웹 빌드 결과(`web/dist`) 경로. 없으면 정적 파일을 내려주지 않는다 |
| `SPACELOG_DEV_ORIGIN` | | 개발할 때만. 예 `http://localhost:5173` |
| `SPACELOG_VAULT_DIR` | | 보관함 폴더 (`archive.db`·`originals/`·`thumbnails/`·`tmp/`). 없으면 DB를 쓰는 API(재발견·내보내기)를 붙이지 않는다 |

서버는 실제 포트를 알린다.

- `utilityProcess`: `process.parentPort`로 `{ type: "listening", port }` 또는 `{ type: "error", message }`
- 그 밖: stdout에 같은 내용을 JSON 한 줄로

## 개발

```bash
# 서버만 켜기 (Node 24는 .ts를 그대로 실행)
SPACELOG_TOKEN=dev SPACELOG_DEV_ORIGIN=http://localhost:5173 SPACELOG_VAULT_DIR=./.vault node apps/server/index.ts

# 데모 시드: 빈 보관함에 7일 전 별 3개 + 이번 주 별 20개 (DEMO 1장). 별이 이미 있으면 거부한다
node apps/server/vault/seed.ts ./.vault

# 웹은 실제 서버로: web/.env.local 에 API_TARGET=http://127.0.0.1:47800
# → 브라우저에서 http://localhost:5173/#/?token=dev
```

## 보안 (POLICY 1-3)

요청마다 Host → Origin → (API만) `X-Session-Token` 순서로 검사한다. 하나라도 틀리면 403/401. CORS 헤더는 보내지 않는다. 정적 파일은 토큰 없이 내려준다 (ADR 0002 5-1).
