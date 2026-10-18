// ============================================================
// web/lib/response — 统一 JSON 响应工具
// ============================================================
//
// 文件职责：
//   - apiSuccess / apiFail / handleApiError —— UI-facing 路由的统一 envelope
//     （GC-4 契约：成功 {success:true,data} / 失败 {success:false,error,code?,
//     category?,retryable?,suggestion?}）。从 app1 `core/api/auth.ts` 镜像字段名。
//   - apiOk / apiError / unauthorized / forbidden —— M2M 路由的裸数据形态
//     （render-jobs/*, client/*, sse 等）；保留不动，避免改动 M2M 契约。
//
// 命名冲突说明：
//   早期 dramaforge 已存在 `apiError(error, status, extra?)`（bare `{error, ...extra}`
//   形态），被 lib/render-job-guard.ts、api/client/*、api/sse 等多个 M2M 路由引用。
//   新 envelope 失败 helper 若也叫 `apiError` 会与其签名/语义冲突，且 M2M 路由
//   不在本任务改动范围。故新失败 helper 命名为 `apiFail`，与 `apiSuccess` 配对。
//   命名不对称是有意为之，可在 grep 时一眼区分 envelope 流 vs M2M 流。
//
// web 禁止 import 任何 ffmpeg 模块；本模块为纯工具。
// ============================================================

import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { BillingError } from '@dramaforge/server';
import { AuthError } from './auth';

// ============================================================
// M2M 路由 helpers（bare data）—— 勿在新代码使用
// ============================================================

/** 成功响应（默认 200）—— M2M 裸数据形态 */
export function apiOk<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

/** 错误响应 —— M2M 裸形态 `{error, ...extra}` */
export function apiError(
  error: string,
  status = 400,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ error, ...extra }, { status });
}

/** 401 未登录 —— M2M 形态 */
export function unauthorized(): NextResponse {
  return apiError('未登录', 401);
}

/** 403 无权限 —— M2M 形态 */
export function forbidden(msg = '无权限'): NextResponse {
  return apiError(msg, 403);
}

// ============================================================
// UI-facing envelope helpers（GC-4 契约）
// ============================================================

/**
 * 构造成功响应 —— `{ success: true, data }`
 *
 * @param data   任意可序列化数据
 * @param status HTTP 状态码，默认 200
 *
 * @example
 *   return apiSuccess({ id: 1 });        // 200 { success: true, data: { id: 1 } }
 *   return apiSuccess({ id: 1 }, 201);   // 201 ...
 */
export function apiSuccess(data: unknown, status = 200): NextResponse {
  return NextResponse.json({ success: true, data }, { status });
}

/** apiFail 入参：失败 envelope 的可选字段，全部 optional 除 error 外 */
export interface ApiFailOptions {
  /** 用户可读错误信息（必填） */
  error: string;
  /** 错误代码（如 'UNAUTHORIZED' / 'VALIDATION_ERROR'） */
  code?: string;
  /** 错误类别（如 'auth' / 'provider'） */
  category?: string;
  /** 是否可重试 */
  retryable?: boolean;
  /** 处理建议（给用户的下一步） */
  suggestion?: string;
}

/**
 * 构造失败响应 —— `{ success: false, error, code?, category?, retryable?, suggestion? }`
 *
 * 未提供的 optional 字段不会出现在 JSON 中（JSON.stringify 丢弃 undefined）。
 *
 * @param opts   失败信息（必须含 error，其余 optional）
 * @param status HTTP 状态码，默认 400
 */
export function apiFail(opts: ApiFailOptions, status = 400): NextResponse {
  const body: {
    success: false;
    error: string;
    code?: string;
    category?: string;
    retryable?: boolean;
    suggestion?: string;
  } = { success: false, error: opts.error };
  if (opts.code !== undefined) body.code = opts.code;
  if (opts.category !== undefined) body.category = opts.category;
  if (opts.retryable !== undefined) body.retryable = opts.retryable;
  if (opts.suggestion !== undefined) body.suggestion = opts.suggestion;
  return NextResponse.json(body, { status });
}

/**
 * 统一异常处理 —— 将 try/catch 捕获的未知错误转为 envelope 响应
 *
 * 识别三种形态：
 *   1. AuthError      → opts.statusCode（通常 401/403），透传 code
 *   2. ZodError       → 400，code='VALIDATION_ERROR'（M6：对外不暴露 schema 细节）
 *   3. 其他 / 未知     → 500，code='INTERNAL_ERROR'
 *
 * 安全约束（I5 + M6）：
 *   - 兜底 500 不再 console.error 全量 error 对象（可能含连接串 / SQL 参数 / 手机号
 *     等敏感字段），只记 message + name + PG code 等结构化字段，便于运维定位。
 *   - ZodError 对外只返回"输入校验失败，请检查请求体字段"，schema path / expected
 *     类型等细节只在服务端日志，避免向外暴露内部字段名与校验规则。
 *
 * @param error   捕获到的错误（unknown）
 * @param context 错误上下文描述，仅用于日志定位
 */
export function handleApiError(error: unknown, context?: string): NextResponse {
  // 1. AuthError（route handler 显式抛出）
  if (error instanceof AuthError) {
    return apiFail(
      { error: error.message, code: error.code },
      error.statusCode,
    );
  }

  // 2. BillingError（计费层抛出：402 余额不足 / 404 用户不存在）→ 透传其 statusCode
  //    —— direct-media-generation.billDirectGeneration 对 402「不够扣就不让用」重抛，
  //    经路由外层 catch 走到这里，映射成 402 不交付生成结果。
  if (error instanceof BillingError) {
    return apiFail(
      {
        error: error.message,
        code: error.statusCode === 402 ? 'INSUFFICIENT_BALANCE' : 'BILLING_ERROR',
        category: 'billing',
      },
      error.statusCode,
    );
  }

  // 3. ZodError（请求体校验失败）
  if (error instanceof ZodError) {
    // M6：详情进服务端日志，对外只给泛化提示
    console.warn(
      `[handleApiError]${context ? ` [${context}]` : ''} body 校验失败:`,
      error.issues,
    );
    return apiFail(
      {
        error: '输入校验失败，请检查请求体字段',
        code: 'VALIDATION_ERROR',
        category: 'validation',
      },
      400,
    );
  }

  // 3. 兜底 500
  // I5：只记结构化字段，不 dump 全量 error（防连接串/SQL 参数/手机号等敏感字段外泄）
  const msg = error instanceof Error ? error.message : String(error);
  const errCode =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : undefined;
  console.error(
    `[handleApiError]${context ? ` [${context}]` : ''} 未处理的异常:`,
    {
      message: msg,
      name: error instanceof Error ? error.name : typeof error,
      ...(errCode ? { code: errCode } : {}),
    },
  );
  return apiFail(
    { error: msg || '服务器内部错误', code: 'INTERNAL_ERROR' },
    500,
  );
}