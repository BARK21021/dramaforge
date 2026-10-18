# Include this file inside the your-domain.example.com `server {}` block.
# It keeps uploads and generated media as bounded streams instead of buffering them on the 1.8GB host.

# Browser <- Next.js：任务进度使用长连接 SSE；这里关闭代理缓冲与压缩，保证事件立即送达前端。
location = /api/sse {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_set_header Accept-Encoding "";
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    chunked_transfer_encoding on;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

# Electron/browser -> Next.js：参考图正文直接流式转发，应用层仍执行 9MiB 业务上限。
location ~ ^/api/projects/[^/]+/assets/[^/]+/generate-image$ {
    client_max_body_size 10M;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
}

# Electron/browser -> Next.js -> Kimi：单集视频正文按背压接力，禁止 Nginx 先写完整临时文件。
# 110M 同时兼容旧 1.1.6 multipart 的边界开销；应用路由仍严格执行 100MiB 业务上限。
location ~ ^/api/projects/[^/]+/episodes/[^/]+/video-to-script$ {
    client_max_body_size 110M;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_request_buffering off;
    proxy_buffering off;
    # 两次 Kimi 流式分析各允许 600s，再预留上传和落库时间，避免仍在执行的任务被误报失败。
    proxy_read_timeout 1800s;
    proxy_send_timeout 1800s;
}

# AI provider -> Next.js：一次性中继地址直接流式接力，不在小内存服务器缓存完整媒体。
location ^~ /api/media-relay/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
}
