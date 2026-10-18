/**
 * @file shot-label.ts — 镜头详细编号统一格式。
 *
 * 跨「分镜表 / 镜头组库 / 成片库」三处共用，避免格式漂移。
 * 格式：第{集号}集·{组名}·镜头{NN}（范围用 镜头{NN}–{MM}）。
 * 集号/组名缺省时省略对应段，保证退化仍可读。
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 单镜头详细编号，如「第3集·高潮组·镜头04」。
 */
export function formatShotLabel(
  episodeNumber: number | null | undefined,
  groupName: string | null | undefined,
  shotIndex: number,
): string {
  const parts: string[] = [];
  if (typeof episodeNumber === 'number' && episodeNumber > 0) parts.push(`第${episodeNumber}集`);
  if (groupName) parts.push(groupName);
  parts.push(`镜头${pad2(shotIndex)}`);
  return parts.join('·');
}

/**
 * 镜头范围编号，如「第3集·高潮组·镜头01–06」；start===end 退化为单镜头编号。
 */
export function formatShotRange(
  episodeNumber: number | null | undefined,
  groupName: string | null | undefined,
  startShotIndex: number,
  endShotIndex: number,
): string {
  if (startShotIndex === endShotIndex) {
    return formatShotLabel(episodeNumber, groupName, startShotIndex);
  }
  const parts: string[] = [];
  if (typeof episodeNumber === 'number' && episodeNumber > 0) parts.push(`第${episodeNumber}集`);
  if (groupName) parts.push(groupName);
  parts.push(`镜头${pad2(startShotIndex)}–${pad2(endShotIndex)}`);
  return parts.join('·');
}
