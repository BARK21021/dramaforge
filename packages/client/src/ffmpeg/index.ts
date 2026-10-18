// ============================================================
// ⑧ client/ffmpeg — ffmpeg pipeline + grid overlay (runs LOCALLY on the client)
// ============================================================
//
// Migrated from app1 core/video/ffmpeg-pipeline.ts + grid-overlay.ts.
// Server storage-factory dependency stripped; ffmpeg NEVER runs on the server
// (this module is a leaf — must not import any @server/*, @client/render-worker
// or @client/orchestrators module).
//
// Public API:
//   - getFfmpegPath()                  — bundled ffmpeg binary path
//   - getVideoDuration(url)            — probe duration (s) via ffmpeg -i
//   - downloadClips(urls, dir)         — download remote URLs to local files
//   - execFfmpegConcat(clips, outPath) — concat clips via concat demuxer
//   - extractLastFrame(videoUrl, out)  — last frame as image
//   - splitVideoByDuration(url, sec, prefix) — stream-copy segment split
//   - splitVideoEvenly(url, n, prefix)      — re-encode into exactly N segments
//   - gridOverlay(frames, outPath)     — sparse grid overlay via sharp
//   - resolveStorageUrl(url)           — no-op pass-through (server dep stripped)
// ============================================================

export * from './ffmpeg-pipeline';
export * from './grid-overlay';
