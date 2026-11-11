// 로컬 서버 실행 진입점.
// - 수집 앱(Electron utilityProcess)이 환경 변수로 토큰·포트·경로를 넘겨 켠다 (ADR 0001 5장)
// - 실제 포트는 { type: "listening", port } 메시지로 알린다. utilityProcess가 아니면 stdout에 한 줄 JSON
// - 개발: SPACELOG_TOKEN=dev SPACELOG_DEV_ORIGIN=http://localhost:5173 SPACELOG_VAULT_DIR=./.vault node apps/server/index.ts
import { routes, startServer } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { exportRoutes } from "./routes/export.ts";
import { mountRoutes } from "./routes/mount.ts";
import { rediscoveryRoutes } from "./routes/rediscovery.ts";
import { openVault } from "./vault/db.ts";

type ParentPort = { postMessage(message: unknown): void };
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;

function report(message: { type: "listening"; port: number } | { type: "error"; message: string }): void {
  if (parentPort) parentPort.postMessage(message);
  else console.log(JSON.stringify(message));
}

try {
  const config = configFromEnv();
  if (config.vaultDir) {
    const vault = openVault(config.vaultDir);
    mountRoutes(routes, rediscoveryRoutes(vault));
    mountRoutes(routes, exportRoutes(vault));
  }
  const { port } = await startServer(config);
  report({ type: "listening", port });
} catch (err) {
  report({ type: "error", message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
