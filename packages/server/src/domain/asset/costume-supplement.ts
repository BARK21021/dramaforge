import {
  slugifyCostumeKey,
  type CostumeMapEntry,
  type ExtractedAssets,
} from '@server/domain/prompt';

function nameAliases(value: string): Set<string> {
  const aliases = new Set<string>();
  const add = (name: string) => {
    const normalized = name.normalize('NFKC').trim().toLocaleLowerCase();
    if (normalized) aliases.add(normalized);
  };
  add(value);
  const match = value.match(/^(.*?)\s*[（(]([^()（）]+)[)）]\s*$/);
  if (match) {
    add(match[1]);
    add(match[2]);
  }
  return aliases;
}

function namesOverlap(left: string, right: string): boolean {
  const leftAliases = nameAliases(left);
  const rightAliases = nameAliases(right);
  return Array.from(leftAliases).some((alias) => rightAliases.has(alias));
}

/**
 * Restore costume rows omitted by the extraction model. Model-authored rows
 * are kept intact; only missing labels from the analyzed costume table are
 * appended.
 */
export function supplementExtractedCostumes(
  extracted: ExtractedAssets,
  costumeMap: readonly CostumeMapEntry[],
): number {
  let supplemented = 0;

  for (const character of extracted.characters) {
    const rows = costumeMap.filter((entry) => namesOverlap(character.name, entry.character));
    if (rows.length === 0) continue;

    const expected = new Map<string, { label: string; description: string; scenes: Set<string> }>();
    for (const entry of rows) {
      const label = entry.costumeLabel.trim() || 'default';
      const identity = label.normalize('NFKC').toLocaleLowerCase();
      const current = expected.get(identity) ?? { label, description: '', scenes: new Set<string>() };
      if (entry.costumeDesc.length > current.description.length) current.description = entry.costumeDesc;
      if (entry.sceneId) current.scenes.add(entry.sceneId);
      expected.set(identity, current);
    }

    const costumes = character.costumes ?? (character.costumes = []);
    const existingLabels = new Set(
      costumes.map((costume) => costume.label.normalize('NFKC').trim().toLocaleLowerCase()),
    );
    const existingKeys = new Set(costumes.map((costume) => costume.key));

    for (const variant of expected.values()) {
      const labelIdentity = variant.label.normalize('NFKC').trim().toLocaleLowerCase();
      if (existingLabels.has(labelIdentity)) continue;

      const baseKey = costumes.length === 0 || !existingKeys.has('default')
        ? 'default'
        : slugifyCostumeKey(variant.label, costumes.length);
      let costumeKey = baseKey;
      for (let suffix = 1; existingKeys.has(costumeKey); suffix += 1) {
        costumeKey = `${baseKey}-${suffix}`;
      }
      costumes.push({
        key: costumeKey,
        label: variant.label,
        description: variant.description,
        identity_lock: [],
        coverage_scenes: Array.from(variant.scenes),
      });
      existingLabels.add(labelIdentity);
      existingKeys.add(costumeKey);
      supplemented += 1;
    }
  }

  return supplemented;
}
