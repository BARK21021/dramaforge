import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Nginx SSE streaming contract', () => {
  it('has a dedicated unbuffered location for the task event stream', () => {
    // 回归生产进度延迟：通用代理默认会缓冲响应，SSE 必须有独立且可审计的配置。
    const configPath = fileURLToPath(
      new URL('../../../scripts/nginx/dramaforge-media-streaming.inc', import.meta.url),
    );
    const configSource = readFileSync(configPath, 'utf8');
    const sseLocation = configSource.match(
      /^\s*location\s*=\s*\/api\/sse\s*\{([\s\S]*?)^\s*\}/m,
    )?.[1];

    expect(sseLocation).toBeDefined();
    expect(sseLocation).toMatch(/proxy_http_version\s+1\.1\s*;/);
    expect(sseLocation).toMatch(/proxy_set_header\s+Connection\s+["']{2}\s*;/);
    expect(sseLocation).toMatch(/proxy_buffering\s+off\s*;/);
    expect(sseLocation).toMatch(/proxy_cache\s+off\s*;/);
    expect(sseLocation).toMatch(/gzip\s+off\s*;/);
    expect(sseLocation).toMatch(/^\s*proxy_read_timeout\s+3600s\s*;/m);
  });

  it('keeps the raw video request unbuffered for the full Kimi lifecycle', () => {
    // 视频上传后还有两次最长 600s 的模型流；网关不能在应用终态前先报超时。
    const configPath = fileURLToPath(
      new URL('../../../scripts/nginx/dramaforge-media-streaming.inc', import.meta.url),
    );
    const configSource = readFileSync(configPath, 'utf8');
    const videoLocation = configSource.match(
      /^\s*location\s+~\s+\^\/api\/projects\/\[\^\/\]\+\/episodes\/\[\^\/\]\+\/video-to-script\$\s*\{([\s\S]*?)^\s*\}/m,
    )?.[1];

    expect(videoLocation).toBeDefined();
    expect(videoLocation).toMatch(/proxy_request_buffering\s+off\s*;/);
    expect(videoLocation).toMatch(/proxy_buffering\s+off\s*;/);
    // 指令必须真实位于配置行，不能只作为乱码注释中的文本被正则误判为已配置。
    expect(videoLocation).toMatch(/^\s*proxy_read_timeout\s+1800s\s*;/m);
    expect(videoLocation).toMatch(/^\s*proxy_send_timeout\s+1800s\s*;/m);
  });
});
