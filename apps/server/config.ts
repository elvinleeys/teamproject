// 서버 설정 — 수집 앱이 환경 변수로 넘긴다 (ADR 0001 5장 서버 진입점, ADR 0002 5-1).

export interface ServerConfig {
  token: string;
  /** 시작 포트. 사용 중이면 +1씩 최대 10번 (POLICY 1-3). 0이면 OS가 고른다(테스트용) */
  basePort: number;
  /** 웹 빌드 결과(web/dist). 없으면 정적 파일을 내려주지 않는다 */
  webDir: string | null;
  /** 개발 중 Vite 개발 서버 Origin. 있을 때만 허용한다 */
  devOrigin: string | null;
  /** 보관함 폴더 (SPEC 2-7). 없으면 DB를 쓰는 API를 붙이지 않는다 */
  vaultDir: string | null;
}

export const DEFAULT_PORT = 47800;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const token = env.SPACELOG_TOKEN;
  // 기본 토큰을 두지 않는다: 토큰 없이 켜지면 다른 웹페이지도 API를 부를 수 있다
  if (!token) throw new Error("SPACELOG_TOKEN이 없어요. 수집 앱이 만든 세션 토큰으로 서버를 켜야 해요");
  const basePort = env.SPACELOG_PORT ? Number(env.SPACELOG_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(basePort) || basePort < 0 || basePort > 65535) {
    throw new Error(`SPACELOG_PORT가 올바른 포트가 아니에요: ${env.SPACELOG_PORT}`);
  }
  return {
    token,
    basePort,
    webDir: env.SPACELOG_WEB_DIR || null,
    devOrigin: env.SPACELOG_DEV_ORIGIN || null,
    vaultDir: env.SPACELOG_VAULT_DIR || null,
  };
}
