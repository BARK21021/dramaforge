// Client <-> server API contracts for the 3 ops skeletons
// (heartbeat / update-check / client-log upload).
// See docs/superpowers/plans/2026-07-18-cs-refactor.md Task 1 Step 2.

export interface HeartbeatRequest {
  version: string;
  os: 'win' | 'mac' | 'linux';
  machineId: string;
}

export interface HeartbeatResponse {
  status: 'ok' | 'force_upgrade';
  minVersion: string;
  latestVersion: string;
  downloadUrl: string;
  /**
   * latestVersion 安装包的 Ed25519 签名（base64）。客户端下载后用编译进二进制的
   * 公钥验签——服务器沦陷也改不了公钥，签不出能过验的包，防供应链投毒。
   * 旧服务器无此字段时为空串，客户端 fail-closed 拒绝安装。
   */
  signature: string;
  /** latestVersion 安装包的 sha256（hex）；传输完整性兜底 + 运维诊断。 */
  sha256: string;
  /**
   * 客户端 render-worker 槽位数提示（多集并行）。全局提示——heartbeat 无鉴权，
   * per-user 真上限由 /api/render/jobs/next 按 users."maxConcurrent" 硬强制。
   * 旧服务器无此字段 → 客户端回退 1 槽。
   */
  renderJobSlots?: number;
}

export interface UpdateCheckRequest {
  version: string;
  os: 'win' | 'mac' | 'linux';
}

export interface UpdateCheckResponse {
  latestVersion: string;
  downloadUrl: string;
  force: boolean;
  /** latestVersion 安装包的 Ed25519 签名（base64）；客户端验签防投毒。 */
  signature: string;
  /** latestVersion 安装包的 sha256（hex）；传输完整性兜底。 */
  sha256: string;
}

export interface ClientLogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

export interface ClientLogBatch {
  machineId: string;
  taskId?: string;
  logs: ClientLogEntry[];
}
