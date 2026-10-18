# MinIO 公网入口 Runbook（`minio.your-domain.example.com`）

> 为 dramaforge 的 MinIO 对象存储开一个公网子域名入口，让浏览器/客户端能直接走
> presigned URL 上传/下载大视频与 AI 产物。
>
> 服务器：`root@YOUR_SERVER` (your-domain.example.com)。SSH key `~/.ssh/deploy_key`。
> 所有本地脚本在仓库根执行：`cd /d/dramaforge-cs`。
> 相关：`scripts/provision-nginx-minio.sh`、`scripts/nginx/minio-your-domain.conf`、
> `packages/server/src/domain/storage/minio.ts`（signing-client split + path-prefix guard）。

## 为什么用子域名，而不是路径前缀

MinIO presigned URL 用 AWS SigV4 签名，签名串里同时包含 **Host 头** 和 **URL path**。
所以：

- 路径前缀（如 `https://your-domain.example.com/minio/<bucket>/<key>`）行不通——多出的
  `/minio` 段会让每个 presigned URL 验签失败。`packages/server/src/domain/storage/minio.ts`
  里专门有运行时 guard 拒绝 path-prefix 形态的 `MINIO_PUBLIC_BASE_URL`。
- 必须用独立子域 `minio.your-domain.example.com`，由 nginx 反代到 `127.0.0.1:9000`。
- nginx 必须原样透传客户端的 `Host` 头（`proxy_set_header Host $host`），
  否则 MinIO 收到的 Host 与签名时不同 → 验签失败 → 全部 presigned URL 403。

## 拓扑

```
客户端 ──HTTPS──> minio.your-domain.example.com  (nginx :443, certbot 签)
                         │ proxy_pass http://127.0.0.1:9000
                         │ proxy_set_header Host $host  ← 保 SigV4 签名
                         ▼
                  dramaforge MinIO 容器（internal-only，仅绑 127.0.0.1:9000）
```

---

## Prerequisite（用户必须先做）

**加 DNS A 记录**：`minio.your-domain.example.com` → `YOUR_SERVER`

- 在域名服务商（DNSPod / 阿里云 / Cloudflare 等）面板添加：
  - 类型：A
  - 主机记录：`minio`
  - 记录值：`YOUR_SERVER`
  - TTL：默认即可（600s）
- 验证生效（本地任意终端）：
  ```bash
  nslookup minio.your-domain.example.com
  # 或
  dig +short minio.your-domain.example.com
  ```
  应返回 `YOUR_SERVER`。DNS 生效通常几分钟～几十分钟。

> DNS 没生效就先做 Step 1 也无妨——provision 脚本最后一步公网探测会 WARN，
> 但 server_block 已部署到位，DNS 一通就立刻可用。

同时确认服务器侧：

- `dramaforge-minio` 容器在跑、绑 `127.0.0.1:9000`：
  ```bash
  ssh -i ~/.ssh/deploy_key -o StrictHostKeyChecking=no root@YOUR_SERVER \
      "docker ps --format '{{.Names}}  {{.Ports}}' | grep -E 'minio'"
  ```
- nginx 在跑：`... 'systemctl is-active nginx'` → `active`。
- 安全组放行 `:80` 和 `:443`（入方向，源 `0.0.0.0/0`）。

---

## Step 1 — 部署 HTTP server_block（:80）

```bash
cd /d/dramaforge-cs
bash scripts/provision-nginx-minio.sh
```

脚本会：

1. `scp` 上传 `scripts/nginx/minio-your-domain.conf` → 服务器
   `/etc/nginx/conf.d/minio-your-domain.conf`。
2. 远程 `nginx -t` 校验语法。**失败即中止**，不会 reload（保护现网，GC-5）。
3. 校验通过则 `nginx -s reload`。
4. 探测 `http://minio.your-domain.example.com/`，DNS 没好时只 WARN 不退出。

脚本 **不跑 certbot**，不碰 dramaforge `.env`。

---

## Step 2 — 签 HTTPS 证书（certbot）

DNS 已生效 + Step 1 完成后：

```bash
SSH=(ssh -i "$HOME/.ssh/deploy_key" -o StrictHostKeyChecking=no root@YOUR_SERVER)

"${SSH[@]}" "certbot --nginx -d minio.your-domain.example.com --redirect --non-interactive --agree-tos -m admin@your-domain.example.com"
```

certbot 会：

- 自动在 `minio-your-domain.conf` 里追加 `listen 443 ssl;` + 证书路径 +
  `:80 → :443` redirect。
- 跑 `nginx -t` 并 reload（certbot 自己保证不 reload 坏配置）。
- 注册到 systemd renew timer（`certbot.timer`），后续自动续期。

验证证书：

```bash
curl -sI https://minio.your-domain.example.com/   # 应见 HTTP/2 200 或 MinIO 响应头
echo | openssl s_client -connect minio.your-domain.example.com:443 -servername minio.your-domain.example.com 2>/dev/null \
    | openssl x509 -noout -subject -dates
```

---

## Step 3 — 切 dramaforge `.env`（仅 cutover / re-cutover 时）

把 presigned URL 的公网 host 指向新入口。**仅在准备把生产流量切到 dramaforge 时改**，
不是这一步立刻就要改。

在服务器 `/opt/dramaforge/.env`：

```env
MINIO_PUBLIC_BASE_URL=https://minio.your-domain.example.com
```

（默认未设置时，`packages/server/src/infra/env.ts` schema 允许缺省，回退到内网
`MINIO_ENDPOINT`，便于本地/裸机开发。生产 cutover 时才填上面这行。）

改完重启 web + ai-worker 让 signing-client 读到新值：

```bash
SSH=(ssh -i "$HOME/.ssh/deploy_key" -o StrictHostKeyChecking=no root@YOUR_SERVER)
"${SSH[@]}" "cd /opt/dramaforge && docker compose up -d --no-build web ai-worker"
"${SSH[@]}" "cd /opt/dramaforge && docker compose logs --tail=30 web | grep -i minio"
```

---

## Step 4 — 验证

1. **公开对象 200**：找一个 bucket 里已知存在的对象（或临时传一个），
   ```bash
   curl -I https://minio.your-domain.example.com/<bucket>/<public-object>
   # 期望：HTTP/2 200（或 403 if 私有，这也是正常——签名验证才放行）
   ```

2. **presigned GET URL**：在 dramaforge 后台或客户端 UI 里触发一次下载/预览，
   拿到的 URL 应形如
   `https://minio.your-domain.example.com/<bucket>/<key>?X-Amz-Algorithm=...&X-Amz-Signature=...`，
   浏览器直接打开能下载到文件（不报 403）。

3. **大文件上传**：客户端上传一个 ≥100MB 视频，整段走完不中断
  （`client_max_body_size 0` 已去限制 + `proxy_buffering off` 流式）。

4. **签名回归**：浏览器 DevTools 看 presigned 请求的 Host 头 =
   `minio.your-domain.example.com`；nginx access log 里 upstream 请求的 Host 也应是
   `minio.your-domain.example.com`（被原样透传）。

---

## Rollback

需要临时关掉 MinIO 公网入口（例如发现滥用或证书问题）：

```bash
SSH=(ssh -i "$HOME/.ssh/deploy_key" -o StrictHostKeyChecking=no root@YOUR_SERVER)

# 1. 摘掉 server_block
"${SSH[@]}" "rm -f /etc/nginx/conf.d/minio-your-domain.conf"

# 2. 校验 + reload（同样先 -t 再 reload，保护现网）
"${SSH[@]}" "nginx -t && nginx -s reload"

# 3.（可选）撤 certbot 证书
"${SSH[@]}" "certbot delete --cert-name minio.your-domain.example.com -n"
```

并清空 dramaforge `.env` 里的 `MINIO_PUBLIC_BASE_URL`（注释掉或删行），重启
`web` + `ai-worker`。回退后 presigned URL 会退回内网 host，公网客户端
无法上传/下载，但 dramaforge 服务本身不挂。

---

## 速查

| 阶段 | 命令 | 谁来跑 |
|---|---|---|
| 加 DNS A 记录 | 域名服务商面板：`minio` → `YOUR_SERVER` | 用户 |
| 部署 :80 server_block | `bash scripts/provision-nginx-minio.sh` | 控制端（本地） |
| 签 HTTPS + redirect | `ssh ... certbot --nginx -d minio.your-domain.example.com --redirect` | 控制端（本地） |
| 切 dramaforge .env | `MINIO_PUBLIC_BASE_URL=https://minio.your-domain.example.com` + restart | 仅 cutover 时 |
| 验证 | `curl -I https://minio.your-domain.example.com/<bucket>/<object>` | 控制端 |
| 回滚 | 删 conf → `nginx -t && nginx -s reload` | 控制端 |
