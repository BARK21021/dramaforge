// ============================================================
// ③ server/domain/seedance-presets — barrel
// ============================================================
// 用户级 Seedance 参数模板 CRUD；所有写操作均带 userId 归属守卫。
// ============================================================

export {
  MAX_SEEDANCE_PRESETS_PER_USER,
  MAX_SEEDANCE_PRESET_NAME_LENGTH,
  SeedancePresetError,
  listSeedancePresets,
  createSeedancePreset,
  updateSeedancePreset,
  deleteSeedancePreset,
  seedancePresetRepo,
  type SeedancePreset,
  type CreateSeedancePresetInput,
  type UpdateSeedancePresetInput,
  type SeedancePresetErrorCode,
} from './service';
