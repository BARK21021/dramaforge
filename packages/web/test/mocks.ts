// ============================================================
// web/test/mocks — 共享 mock 控制对象
// ============================================================
//
// 集中定义 @dramaforge/server 与 next-auth 的 mock，供所有测试文件复用。
// 用 vi.hoisted 确保 mock 控制对象在 vi.mock 工厂执行前就定义好。
//
// 设计要点：
//   - serverMock 提供 web 路由用到的所有 @dramaforge/server 运行时导出
//     （类型导出在运行时 erased，无需 mock）
//   - GatewayError 是真实 class（非 vi.fn），保证 instanceof 检查生效
//   - renderJobRepo 是聚合对象，其方法是 vi.fn()
//   - getRedis 返回一个 mock redis 实例（publish/duplicate/subscribe/on/...）
//   - getServerSessionMock 控制登录态（返回 session 对象或 null）
//
// web 禁止 import 任何 ffmpeg 模块；本文件仅做 mock 装配。
// ============================================================

import { vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  /** 模拟 ⑥ ai-worker 的 GatewayError（保持 instanceof 语义） */
  class MockGatewayError extends Error {
    readonly provider: string;
    readonly status: number | null;
    readonly retryAfter: number | null;
    constructor(
      provider: string,
      message: string,
      status: number | null = null,
      retryAfter: number | null = null,
    ) {
      super(message);
      this.name = 'GatewayError';
      this.provider = provider;
      this.status = status;
      this.retryAfter = retryAfter;
    }
  }

  /** 模拟 ③ domain/payment 的 PaymentError（保持 instanceof 语义） */
  class MockPaymentError extends Error {
    readonly statusCode: number;
    readonly code?: string;
    constructor(message: string, statusCode: number = 400, code?: string) {
      super(message);
      this.name = 'PaymentError';
      this.statusCode = statusCode;
      this.code = code;
    }
  }

  /** 模拟 Seedance 预设领域错误，保留 instanceof 与 HTTP 状态语义。 */
  class MockSeedancePresetError extends Error {
    readonly statusCode: number;
    readonly code: string;
    constructor(message: string, statusCode: number, code: string) {
      super(message);
      this.name = 'SeedancePresetError';
      this.statusCode = statusCode;
      this.code = code;
    }
  }

  /** 模拟 ③ domain/billing 的 BillingError（保持 instanceof + statusCode 语义）。 */
  class MockBillingError extends Error {
    readonly statusCode: number;
    constructor(message: string, statusCode: number = 402) {
      super(message);
      this.name = 'BillingError';
      this.statusCode = statusCode;
    }
  }

  /** mock redis 实例（publish + duplicate 返回订阅子实例） */
  function createRedisMock() {
    const subscribers: Array<(channel: string, message: string) => void> = [];
    const subInstance = {
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, cb: (channel: string, message: string) => void) => {
        if (event === 'message') subscribers.push(cb);
        return subInstance;
      }),
      off: vi.fn((event: string, cb: (channel: string, message: string) => void) => {
        if (event === 'message') {
          const idx = subscribers.indexOf(cb);
          if (idx >= 0) subscribers.splice(idx, 1);
        }
        return subInstance;
      }),
      quit: vi.fn().mockResolvedValue(undefined),
    };
    const mainInstance = {
      publish: vi.fn().mockResolvedValue(1),
      duplicate: vi.fn(() => subInstance),
    };
    return { mainInstance, subInstance, subscribers };
  }

  return {
    serverMock: {
      // ② gateway
      callAI: vi.fn(),
      GatewayError: MockGatewayError,
      // ④ task
      renderJobRepo: {
        create: vi.fn(),
        createOrReuseChainGenerate: vi.fn(),
        claimNext: vi.fn(),
        // per-user render 并发硬上限计数；默认 0（未满，/next 正常发 job）。
        // 注意 restoreMocks:true 下必须用 vi.fn(impl) 形式（见 getBalance 注释）。
        countActiveClaims: vi.fn(async () => 0),
        getById: vi.fn(),
        listByUser: vi.fn(),
        getByTaskId: vi.fn(),
        cancel: vi.fn(),
        retry: vi.fn(),
        createRetryCopy: vi.fn(),
        markRunning: vi.fn(),
        markResult: vi.fn(),
        markFailed: vi.fn(),
        reapStale: vi.fn(),
      },
      dispatchFilmExport: vi.fn(),
      dispatchChainGenerate: vi.fn(),
      dispatchChainGenerateOnce: vi.fn(),
      dispatchVideoSplit: vi.fn(),
      dispatchLongVideoRewrite: vi.fn(),
      dispatchAiTask: vi.fn(),
      removeQueuedAiJob: vi.fn(),
      enqueueAiTask: vi.fn(),
      getAiTask: vi.fn(),
      cancelAiTask: vi.fn(),
      listAiTasks: vi.fn(),
      // 同步长请求也复用 tasks/SSE：route 通过这四个接口持久化真实阶段进度。
      startInlineAiTask: vi.fn(),
      reportInlineAiTaskProgress: vi.fn(),
      completeInlineAiTask: vi.fn(),
      failInlineAiTask: vi.fn(),
      // ④ task/event-publisher — /api/sse route 在 start() 内调用 listActiveTasksSnapshot
      // 和 listEventsAfter（默认返空数组；个别测试需要时覆盖）。publishTaskEvent 经
      // @web/lib/publish 走 re-export，测试用 vi.mock('@web/lib/publish') 单独 mock。
      listActiveTasksSnapshot: vi.fn().mockResolvedValue([]),
      listEventsAfter: vi.fn().mockResolvedValue([]),
      listTaskProgressClips: vi.fn().mockResolvedValue([]),
      publishTaskEvent: vi.fn(),
      // ③ domain/storyboard — listShots（批8 chain-generate route 测试用）
      listShots: vi.fn(),
      // 成片库按 app1 口径批量核验「分集全部镜头已生成」。
      getEpisodesCompletionMap: vi.fn(),
      replaceEpisodeShots: vi.fn(),
      buildStoryboardPrompt: vi.fn(() => ({ system: 'STORYBOARD_SYSTEM', user: 'STORYBOARD_USER' })),
      parseStoryboardShots: vi.fn((_content: string): Array<Record<string, unknown>> => []),
      postprocessStoryboardShots: vi.fn(),
      buildLocalizedDurationBudget: vi.fn(() => undefined),
      // 显式时长目标解析（generate-storyboard route 用：源视频时长/用户弹窗选择 > 本地化兜底）。
      // 默认 undefined（无显式目标）→ 路由走 buildLocalizedDurationBudget 兜底分支。
      resolveExplicitStoryboardTarget: vi.fn(() => undefined),
      buildExplicitDurationBudget: vi.fn(() => undefined),
      PENCIL_PAINTING_RESTORATION_PROMPT: '所有资产需还原为写实照片风格',
      // ③ domain/prompt — 成组提示词预览纯函数（路由契约测试按需指定结果）。
      buildGroupPreviewPrompt: vi.fn(),
      // 视频语言合同默认视为已锁定；单个路由测试可覆盖边界场景。
      hasLockedTargetLanguage: vi.fn(() => true),
      buildVideoLanguageContract: vi.fn(() => 'TARGET_LANGUAGE_CONTRACT'),
      // ⑦ infra
      authOptions: { session: { strategy: 'jwt' } },
      query: vi.fn(),
      tx: vi.fn(),
      runInTransaction: vi.fn(),
      getRedis: vi.fn(),
      rateLimitAllow: vi.fn(),
      changeUserPassword: vi.fn(),
      env: vi.fn(() => ({
        DATABASE_URL: 'postgres://localhost',
        REDIS_URL: 'redis://localhost',
        MINIO_ENDPOINT: 'localhost:9000',
        MINIO_ACCESS_KEY: 'minio',
        MINIO_SECRET_KEY: 'miniosecret',
        MINIO_BUCKET: 'sf',
        NEXTAUTH_SECRET: 'secret',
        NEXTAUTH_URL: 'http://localhost:3000',
      })),
      // ③ domain
      // getBalance 默认返回高余额（非 ADMIN），让加了 requireBalanceOrFail 前置门的
      // 生成路由在多数路由测试里直接放行；个别测试 mockReturnValueOnce 覆盖 0 余额分支。
      // 注意：必须用 vi.fn(impl) 形式而非 vi.fn().mockResolvedValue()——vitest.config 的
      // restoreMocks:true 每测会 mockRestore，只 restore 回「传给 vi.fn 的原始 impl」，
      // 链式 .mockResolvedValue 会被清成 undefined（与 hasLockedTargetLanguage/env 同理）。
      getBalance: vi.fn(async () => ({
        userId: 'user-1',
        credits: 100000,
        frozenCredits: 0,
        availableCredits: 100000,
        unlimited: false,
      })),
      chargeCredits: vi.fn(),
      // 计费错误类（真实 class，保 instanceof；direct-media-generation 的 402 重抛 +
      // handleApiError 的 statusCode 映射都靠它；测试用 new serverMock.BillingError(...) 制造 402）。
      BillingError: MockBillingError,
      chargeAggregatedTaskCost: vi.fn(),
      yuanToCredits: vi.fn((yuan: number) => Math.max(1, Math.ceil(yuan * 12))),
      creditRefund: vi.fn(),
      refundTaskDebit: vi.fn(),
      creditManual: vi.fn(),
      creditPurchase: vi.fn(),
      // P0-2：sync direct 路径扣费失败写欠费账本（不动 users.credits），补扣 sweep 重试。
      recordPendingDebit: vi.fn(),
      // ③ domain/admin — requireAdmin 的 DB 权威角色重查 + /api/admin/* 路由测试用
      getUserRoleById: vi.fn(),
      listUsersForAdmin: vi.fn(),
      getUserDetailForAdmin: vi.fn(),
      updateUserConcurrency: vi.fn(),
      listLedgerForAdmin: vi.fn(),
      listUserFilms: vi.fn(),
      listUserFilmsForAdmin: vi.fn(),
      getAdminStats: vi.fn(),
      // ③ domain/api-configs — 平台 API key 池 CRUD（GC-1 非 BYOK）/api/admin/api-configs 用
      listPlatformConfigs: vi.fn(),
      revealPlatformConfigKey: vi.fn(),
      createPlatformConfig: vi.fn(),
      updatePlatformConfig: vi.fn(),
      deletePlatformConfig: vi.fn(),
      resetConfigStatus: vi.fn(),
      testConfig: vi.fn(),
      // ③ domain/seedance-presets — 当前用户参数模板 CRUD。
      SeedancePresetError: MockSeedancePresetError,
      listSeedancePresets: vi.fn(),
      createSeedancePreset: vi.fn(),
      updateSeedancePreset: vi.fn(),
      deleteSeedancePreset: vi.fn(),
      acquireSlot: vi.fn(),
      releaseSlot: vi.fn(),
      // render /next 的 per-user 并发上限（users."maxConcurrent"）；默认 10。
      getConcurrencyLimit: vi.fn(async () => 10),
      getStorage: vi.fn(),
      // ③ domain/project — 项目列表 CRUD（P3）+ getById/update（P7.1 T2/T3）
      projectRepo: {
        listByUser: vi.fn(),
        create: vi.fn(),
        getById: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
      },
      updateCharacterMappingRoleIdentityByAliasMap: vi.fn(),
      // ③ domain/episode — 分集 CRUD（P7.1 T3）
      episodeRepo: {
        listByProject: vi.fn(),
        create: vi.fn(),
        getById: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
        reorder: vi.fn(),
      },
      // ③ domain/payment — 支付宝订单 + 服务（P6/P6.2 /status 路由测试用）
      PaymentError: MockPaymentError,
      paymentOrderRepo: {
        findById: vi.fn(),
        findByOutTradeNo: vi.fn(),
      },
      getPaymentService: vi.fn(),
      // ③ domain/asset — 单条资产读取 + 改名（批3 rename route 用）/ 列项目资产
      // （批8 P7.6 chain-generate route 用 listAssets 拉 CHARACTER 资产做网格叠加索引）
      getAsset: vi.fn(),
      beginAssetImageRevision: vi.fn(),
      markAssetImageRevisionGenerated: vi.fn(),
      markAssetImageRevisionFailed: vi.fn(),
      // 资产生图路由使用的纯函数默认值；单个契约测试可覆盖具体输出。
      buildAssetImagePrompt: vi.fn(() => 'ASSET_PROMPT'),
      sanitizePromptForModeration: vi.fn((prompt: string) => ({
        sanitized: prompt,
        replacements: [] as string[],
      })),
      getResolutionByKey: vi.fn(() => ({ width: 1920, height: 1080 })),
      readLocalizationProfile: vi.fn(() => null),
      assetImageLanguageFromCategory: vi.fn(() => 'zh'),
      updateAsset: vi.fn(),
      updateAssetCostumesPreservingImages: vi.fn(),
      deleteAsset: vi.fn(),
      listAssets: vi.fn(),
      replaceExtractedAssets: vi.fn(),
      supplementExtractedCostumes: vi.fn(),
      buildAssetExtractionPrompt: vi.fn(),
      parseAssetExtraction: vi.fn(),
      reconcileExtractedAssetCharacterNames: vi.fn(),
      validateSuggestedVoices: vi.fn(),
      isAnonymousCharacterName: vi.fn(() => false),
      languageFromCategory: vi.fn(() => 'zh'),
      loadPresetVoiceManifest: vi.fn(() => []),
      parseScriptResult: vi.fn(),
      // 单镜头资产重绑：normalizeAssetName 为真实实现（路由用它建 kind:normalized 键，
      // 必须与 resolver 口径一致；mock 成 undefined 会让名字解析全失败）。
      normalizeAssetName: (name: unknown): string =>
        typeof name === 'string'
          ? name.toLowerCase().replace(/[\s\-_·.,'"()（）]/g, '')
          : '',
      // 结构校验纯函数（真实逻辑由 server 包单测覆盖）；路由测试用 vi.fn 控制返回以
      // 验证路由的错误映射，默认放行让路由走到名字解析分支。
      // 显式标注返回类型（与 server ShotValidationResult 同形），否则 `valid: true as const`
      // 被窄化成字面量 true、`errors: []` 推成 never[]，导致 route 测试 mockReturnValueOnce
      // 传 { valid: false, errors: [...] } 时 tsc 报错（vitest 运行时擦除类型会漏过）。
      validateReferencedAssetsShape: vi.fn(
        (): { valid: boolean; errors: string[] } => ({ valid: true, errors: [] }),
      ),
      renameAsset: vi.fn(),
      // 转绘 X4.4 整剧资产提取（route 测试 mock；真实实现 server/domain/asset/whole-script-extraction）
      extractWholeScriptAssets: vi.fn(),
      // ③ domain/storyboard — 单镜 PATCH 的读取与部分更新。
      getShot: vi.fn(),
      updateShot: vi.fn(),
      RenameValidationError: class MockRenameValidationError extends Error {
        readonly statusCode = 400;
        constructor(message: string) {
          super(message);
          this.name = 'RenameValidationError';
        }
      },
    },
    getServerSessionMock: vi.fn(),
    createRedisMock,
  };
});

vi.mock('@dramaforge/server', () => hoisted.serverMock);

vi.mock('next-auth', () => ({
  getServerSession: hoisted.getServerSessionMock,
  // NextAuth default export: App Router [...nextauth] 路由用 `NextAuth(authOptions)`
  // 返回 handler。mock 成 identity 函数即可（路由本身不在单测范围）。
  default: (opts: unknown) => opts,
}));

export const { serverMock, getServerSessionMock, createRedisMock } = hoisted;

/** 默认已登录 session（user-1 / FREE）。测试里覆盖 getServerSessionMock 返回值。 */
export const DEFAULT_SESSION = {
  user: { id: 'user-1', role: 'FREE' },
  expires: '2099-01-01T00:00:00.000Z',
};
