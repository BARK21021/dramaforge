import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('Next upload proxy limit', () => {
  it('keeps enough multipart headroom for the 100 MiB video route', () => {
    // 回归生产事故：Next 默认 10 MiB 会截断 multipart，最终表现为 FormData 解析失败。
    const configPath = fileURLToPath(new URL('../next.config.mjs', import.meta.url));
    const configSource = readFileSync(configPath, 'utf8');
    expect(configSource).toMatch(/proxyClientMaxBodySize:\s*['"]110mb['"]/);
  });

  it('ships next.config.mjs in the production image used by next start', () => {
    // required-server-files.json 含配置仍不够：next start 缺文件时会以默认配置覆盖为 10MiB。
    const dockerfilePath = fileURLToPath(new URL('../Dockerfile', import.meta.url));
    const dockerfileSource = readFileSync(dockerfilePath, 'utf8');
    expect(dockerfileSource).toContain(
      'COPY --from=builder /app/packages/web/next.config.mjs ./packages/web/next.config.mjs',
    );
  });
});
