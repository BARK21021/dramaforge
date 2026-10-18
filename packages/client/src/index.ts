// Client (Electron desktop app) package. Modules (refactored by sub-agents):
//  ⑧ src/ffmpeg/         — ffmpeg pipeline (migrated from app1, runs locally)
//  ⑨ src/render-worker/  — HTTP pull render-job → local ffmpeg → upload
//  ⑩ src/orchestrators/  — CHAIN_GENERATE / LONG_VIDEO_REWRITE (AI via cloud API)
//  ⑬ src/ops/heartbeat/  — 30s heartbeat + force_upgrade lockout
//  ⑭ src/ops/updater/    — silent auto-updater
//  ⑮ src/ops/logger/     — rolling local log + lazy upload
//  ⑪ main/               — Electron shell (BrowserWindow loads cloud UI) + preload
// Client MUST NOT import any @server/* module (boundary test enforces).
export {};
