// Local mode: standalone server build with API proxy to Fastify
const fastifyPort = process.env.DRAMAFORGE_FASTIFY_PORT || '17419';

const config = {
  reactStrictMode: true,
  output: 'standalone',
  distDir: '.next',
  transpilePackages: ['@dramaforge/server', '@dramaforge/shared'],
  typescript: { ignoreBuildErrors: true },
  experimental: { proxyClientMaxBodySize: '110mb' },
  async rewrites() {
    // ponytail: proxy /api to Fastify only in legacy local-server mode (LOCAL_API_PROXY=1).
    // Default (unified local): web serves its own API directly against the local DB.
    if (process.env.LOCAL_API_PROXY !== '1') return {};
    return {
      beforeFiles: [
        {
          source: '/api/:path*',
          destination: 'http://127.0.0.1:' + fastifyPort + '/api/:path*',
        },
      ],
    };
  },
};
export default config;
