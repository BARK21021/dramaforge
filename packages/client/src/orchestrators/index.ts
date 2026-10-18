// ============================================================
// ⑩ client/orchestrators — CHAIN_COMPILE + LONG_VIDEO_REWRITE
// ============================================================
//
// Composite render-job orchestrators. Both delegate AI calls to the cloud
// server over HTTP (AI keys stay server-side — never imported here) and run
// only the ffmpeg pieces locally on the client machine.
//
// Migrated from app1's CHAIN_GENERATE (video.worker.ts handleChainGenerate +
// assembleFilm) and LONG_VIDEO_REWRITE (text.worker.ts handleLongVideoRewrite
// + core/video/long-video-service.ts processLongVideo) flows.
//
// The `orchestrators` object below is the default the Electron shell injects
// into `startRenderWorker({orchestrators})` — see ⑪ client/shell. The
// render-worker executor dispatches CHAIN_COMPILE / LONG_VIDEO_REWRITE jobs to
// these hooks via the injected `Orchestrators` interface (defined in
// ../render-worker/executor.ts).
//
// Leaf module: no @server/* imports (cloud via HTTP only). Imports allowed:
// @client/ffmpeg (via ctx), @client/render-worker (types + uploadArtifact),
// @shared, node built-ins.

import type { Orchestrators } from '../render-worker';
import { chainCompile } from './chain-generate';
import { longVideoRewrite } from './long-video-rewrite';

export { chainCompile } from './chain-generate';
export type { ChainGroupEntry } from './chain-generate';
export { longVideoRewrite } from './long-video-rewrite';

/**
 * Default `Orchestrators` instance injected into `startRenderWorker`.
 *
 * Both hooks are present (non-optional): the shell always wires both
 * composite job types. If a future deployment wants to disable one, it can
 * pass a custom `{}` object to `startRenderWorker` — the executor will throw
 * "orchestrator not configured for <TYPE>" if a job of that type is claimed
 * without its hook.
 */
export const orchestrators: Orchestrators = {
  chainCompile,
  longVideoRewrite,
};
