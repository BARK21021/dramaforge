// ⑨ client/render-worker barrel.
//
// HTTP-pulls render-jobs from the cloud server, runs ffmpeg locally, uploads
// artifacts, and reports result/failed. Talks to the server ONLY via HTTP
// (no @server/* imports). Orchestrators (Task ⑩) are injected, not hard-imported.

export { startRenderWorker } from './loop';
export type {
  StartRenderWorkerOptions,
  RenderWorkerHandle,
  RenderWorkerLogger,
} from './loop';
export { executeJob } from './executor';
export type {
  Orchestrators,
  OrchestratorContext,
  ExecuteJobDeps,
  ExecutorLogger,
} from './executor';
export { uploadArtifact } from './uploader';
