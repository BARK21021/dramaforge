// Build script: bundles local-server with esbuild
import { build } from 'esbuild';

const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/index.cjs',
  sourcemap: true,
  external: [
    'better-sqlite3',
    'electron',
    'fs',
    'path',
    'crypto',
    'http',
    'stream',
    'zlib',
    'url',
    'os',
    'events',
    'util',
    'querystring',
    'net',
    'buffer',
  ],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  loader: { '.sql': 'text' },
  logLevel: 'info',
};

if (isWatch) {
  const ctx = await build({ ...options, write: false });
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await build(options);
  console.log('Build complete �� dist/index.cjs');
}