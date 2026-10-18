// ============================================================
// ⑧ client/ffmpeg — sparse grid overlay (migrated from app1 core/video/grid-overlay.ts)
// ============================================================
//
// Overlays a sparse white-line grid (with stroke-opacity) onto a frame image
// using sharp. Uses:
//   1. chain-generate: the previous group's last frame is overlaid with a grid
//      to serve as the next group's reference frame (visual continuity).
//   2. character reference frames: when a CHARACTER asset has
//      `gridOverlayEnabled === true`, the asset's design image gets a sparse
//      grid overlaid before being submitted to the cloud AI as a reference —
//      used for composition alignment (rule-of-thirds assist).
//
// 产品名虽叫“稀疏网格”，默认参数 100 格、透明度 0.6、线宽 1，用于干扰 Seedance 真人
// 检测，而不是构图九宫格。人物参考图的实际密度由 chain-generate params.gridCells
// 注入（route 校验 4-400），缺省才回退到 DEFAULT_GRID_CELLS=100（对齐 app1）。
//
// This module only draws the grid on an existing image; URL download and
// size validation are the caller's responsibility.
//
// Migration note: app1 exposed overlayGridOnBuffer / overlayGridOnFile. The
// client API surface is the higher-level gridOverlay(frames, outPath) which
// reads frames[0], overlays the grid, and writes the result to outPath.
// ============================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

/**
 * Default grid cell count per axis（对齐 app1 的 100 格）。
 *
 * 人物参考图的实际密度由 chain-generate 的 params.gridCells 注入（route 校验 4-400）；
 * 仅当调用方未传 cells 时回退到此默认值。
 */
export const DEFAULT_GRID_CELLS = 100;

export interface GridOverlayOptions {
  /**
   * Grid cell count per axis. Default 100（对齐 app1）。
   */
  cells?: number;
  /** Grid line opacity 0..1 (default 0.6). */
  opacity?: number;
  /** Grid line stroke width in px (default 1). */
  strokeWidth?: number;
}

/**
 * Overlay a sparse grid on `frames[0]` and write the result to `outPath`.
 *
 * The first frame is used as the base (in the chain-generate flow the caller
 * passes the single extracted last-frame path; for a multi-element array the
 * primary/first element is used). Output format is inferred from `outPath`'s
 * extension by sharp (use .png for lossless, .jpg for smaller size).
 *
 * @param frames - frame image file paths (the first is used as the base)
 * @param outPath - output image path
 * @param opts - grid parameters
 * @throws if `frames` is empty, the base image cannot be read, or dimensions
 *   are invalid
 */
export async function gridOverlay(
  frames: string[],
  outPath: string,
  opts?: GridOverlayOptions,
): Promise<void> {
  if (frames.length === 0) {
    throw new Error('gridOverlay: frames is empty');
  }
  const imageBuf = await fs.readFile(frames[0]);
  const outBuf = await overlayGridOnBuffer(imageBuf, opts);
  await fs.writeFile(outPath, outBuf);
}

/**
 * Overlay a sparse white-line grid on an image Buffer.
 * Returns a PNG Buffer (matching app1's behavior).
 */
async function overlayGridOnBuffer(
  imageBuf: Buffer,
  opts?: GridOverlayOptions,
): Promise<Buffer> {
  const gridCells = opts?.cells ?? DEFAULT_GRID_CELLS;
  const gridOpacity = opts?.opacity ?? 0.6;
  const gridStrokeWidth = opts?.strokeWidth ?? 1;

  const metadata = await sharp(imageBuf).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) {
    throw new Error(`gridOverlay: invalid image dimensions: ${width}x${height}`);
  }

  const gridCellW = width / gridCells;
  const gridCellH = height / gridCells;

  // Build the SVG grid: vertical then horizontal white lines with opacity.
  let svgPaths = '';
  for (let i = 1; i < gridCells; i++) {
    svgPaths += `<line x1="${i * gridCellW}" y1="0" x2="${i * gridCellW}" y2="${height}" stroke="white" stroke-opacity="${gridOpacity}" stroke-width="${gridStrokeWidth}"/>`;
  }
  for (let i = 1; i < gridCells; i++) {
    svgPaths += `<line x1="0" y1="${i * gridCellH}" x2="${width}" y2="${i * gridCellH}" stroke="white" stroke-opacity="${gridOpacity}" stroke-width="${gridStrokeWidth}"/>`;
  }

  const svgOverlay = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${svgPaths}</svg>`,
  );

  return sharp(imageBuf)
    .composite([{ input: svgOverlay, blend: 'over' }])
    .png()
    .toBuffer();
}

/**
 * 人物参考图网格叠加完整管线（对齐 app1 providers.ts applyGridOverlay）。
 *
 * dramaforge 把 app1 服务端 providers.ts 的人物参考图处理搬到客户端（服务器零 ffmpeg）。
 * 原始图片 Buffer → 格式校验(jpeg/png/webp) → ARK 尺寸边界(300-6000)校正 →
 * 最大边压到 1280px（保证网格线密度合理 + 缩小 base64 体积，避免 Seedance 编码异常）→
 * 叠加稀疏网格(cells/opacity/strokeWidth) → JPEG q88 重编码 → 体积校验(<30MB) → JPEG Buffer。
 *
 * 与 gridOverlay（仅叠加，用于串联末帧构图辅助）的区别：本函数多了 resize + JPEG 重编码，
 * 这是 app1 人物参考图绕 Seedance 2.0 真人检测的完整处理流程。
 *
 * @param imageBuf - 原始人物参考图 Buffer（jpeg/png/webp）
 * @param opts - 网格参数；缺省走 DEFAULT_GRID_CELLS / 0.6 / 1
 * @returns 叠加网格后的 JPEG Buffer（调用方自行转 data:image/jpeg;base64）
 * @throws 格式不支持 / 尺寸无效 / 体积超 30MB
 */
export async function applyCharacterReferenceGrid(
  imageBuf: Buffer,
  opts?: GridOverlayOptions,
): Promise<Buffer> {
  // Face-region-only grid: try Python + OpenCV DNN face detection first,
  // draw grid ONLY on face bounding box(es). Falls back to full-image grid
  // below if Python/cv2 unavailable or detection fails.
  const _faceResult = await tryFaceGridOverlay(imageBuf, opts);
  if (_faceResult) return _faceResult;

  const metadata = await sharp(imageBuf).metadata();
  const format = metadata.format;
  if (!format || !(['jpeg', 'png', 'webp'] as string[]).includes(format)) {
    throw new Error(
      `图片格式不支持: ${format || 'unknown'}（ARK 仅支持 jpeg/png/webp）`,
    );
  }
  let width = metadata.width;
  let height = metadata.height;
  if (!width || !height) {
    throw new Error(`图片尺寸无效: ${width}x${height}`);
  }

  // ARK 尺寸限制 300-6000 px，超出则缩放（对齐 app1 providers.ts）。
  let baseImageBuf: Buffer = imageBuf;
  if (width > 6000 || height > 6000) {
    const resized = await sharp(imageBuf)
      .resize(6000, 6000, { fit: 'inside', withoutEnlargement: true })
      .toBuffer();
    const newMeta = await sharp(resized).metadata();
    width = newMeta.width!;
    height = newMeta.height!;
    baseImageBuf = resized;
  } else if (width < 300 || height < 300) {
    const scale = Math.ceil(300 / Math.min(width, height));
    const resized = await sharp(imageBuf)
      .resize(width * scale, height * scale, { fit: 'fill', withoutEnlargement: false })
      .toBuffer();
    const newMeta = await sharp(resized).metadata();
    width = newMeta.width!;
    height = newMeta.height!;
    baseImageBuf = resized;
  }

  // 压缩人物参考图分辨率：限制最大边 1280px。使 100 格网格线密度合理（1280px 每格 12.8px），
  // 并加速 ARK 处理、避免大图导致 Seedance 编码异常（对齐 app1 MAX_REF_DIMENSION=1280）。
  const MAX_REF_DIMENSION = 1280;
  const maxDim = Math.max(width, height);
  if (maxDim > MAX_REF_DIMENSION) {
    const scale = MAX_REF_DIMENSION / maxDim;
    const resized = await sharp(baseImageBuf)
      .resize(Math.round(width * scale), Math.round(height * scale), {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toBuffer();
    const newMeta = await sharp(resized).metadata();
    width = newMeta.width!;
    height = newMeta.height!;
    baseImageBuf = resized;
  }

  // 网格绘制委托给本模块 overlayGridOnBuffer（与 app1 overlayGridOnBuffer 同源）。
  const griddedBuf = await overlayGridOnBuffer(baseImageBuf, opts);

  // JPEG 重编码（flatten 白底）：显著降低 base64 体积，避免 Seedance 因 image_url 过大返回 InvalidParameter。
  const jpegBuf = await sharp(griddedBuf)
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
  if (jpegBuf.length > 30 * 1024 * 1024) {
    throw new Error(
      `网格参考图体积超限: ${Math.round(jpegBuf.length / 1024 / 1024)}MB（单张图片需小于 30MB）`,
    );
  }
  return jpegBuf;
}

// ============================================================
// Face-region-only grid overlay (Python + OpenCV DNN)
// ============================================================

/**
 * Resolve face-grid script path (bundled in resources/scripts/ or dev fallback).
 * Mirrors the gen_depth.py resolution pattern from chain-generate.ts.
 */
function resolveFaceGridScript(): string | null {
  const resourcesPath = process.resourcesPath ?? '';
  const candidates = [
    path.join(resourcesPath, 'scripts', 'gen_face_grid.py'),
    path.join(resourcesPath, 'app', 'scripts', 'gen_face_grid.py'),
    // dev mode: repo root
    path.join(process.cwd(), 'packages', 'client', 'resources', 'scripts', 'gen_face_grid.py'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Resolve the bundled Python env (same as gen_depth.py). */
function resolvePythonPath(): string | null {
  const userDataPath = path.join(os.homedir(), '.dramaforge');
  const pythonEnvPath = path.join(userDataPath, 'python-env', 'python.exe');
  return existsSync(pythonEnvPath) ? pythonEnvPath : null;
}

/** Resolve model storage dir for DNN face detection models (auto-downloaded on first run). */
function resolveFaceModelDir(): string {
  const userDataPath = path.join(os.homedir(), '.dramaforge');
  return path.join(userDataPath, 'face-models');
}

/**
 * Try face-region-only grid overlay via Python + OpenCV.
 * Returns JPEG Buffer on success, null on fallback (Python/cv2 unavailable).
 */
async function tryFaceGridOverlay(
  imageBuf: Buffer,
  opts?: GridOverlayOptions,
): Promise<Buffer | null> {
  const scriptPath = resolveFaceGridScript();
  const pythonPath = resolvePythonPath();
  if (!scriptPath || !pythonPath) return null;

  const cells = opts?.cells ?? DEFAULT_GRID_CELLS;
  const opacity = opts?.opacity ?? 0.6;
  const strokeWidth = opts?.strokeWidth ?? 1;
  const modelDir = resolveFaceModelDir();

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-facegrid-'));
  const inputPath = path.join(tmpDir, 'input.png');
  const outputPath = path.join(tmpDir, 'output.jpg');

  try {
    await fs.writeFile(inputPath, imageBuf);
    await fs.mkdir(modelDir, { recursive: true });

    await execFileAsync(
      pythonPath,
      [scriptPath, inputPath, outputPath, String(cells), String(opacity), String(strokeWidth), modelDir],
      { timeout: 30_000, windowsHide: true },
    );

    const result = await fs.readFile(outputPath);
    if (result.length === 0) throw new Error('face-grid output empty');
    return result;
  } catch {
    // cv2 missing, image read failure, timeout, etc. -> fall back to full grid
    return null;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
