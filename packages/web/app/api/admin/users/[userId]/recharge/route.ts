// ============================================================
// POST /api/admin/users/[userId]/recharge — 管理员手动充值（对齐 app1 /api/user/recharge）
// ============================================================
//
// 管理员给目标用户手动加积分（1 元 = 10 积分）。不创建 payment_orders（非真实付款，
// 故不计入「氪金总金额」指标），直接写 PURCHASE_CREDIT 账本 + 加余额。
// requireAdmin 守卫 + 金额校验 1–10000 + 可选 idempotencyKey 幂等（防双击）。
//
// 幂等：调用方（前端表单）每次提交附 UUID idempotencyKey；服务端 creditManual 命中
// 同 (targetUserId, idempotencyKey, adminUserId) 的历史记录时直接返回，**不双扣**。
// 这是 dramaforge 增量（app1 无）；对齐 app1 不影响（app1 不发 idempotencyKey 走原路径）。
//
// 响应：200 { success:true, data:{ credits, rechargeCredits, ledgerId, idempotent? } } /
//      400 BAD_AMOUNT / 401 / 403
// ============================================================

import type { NextRequest } from 'next/server';
import { creditManual } from '@dramaforge/server';
import { requireAdmin } from '@web/lib/auth';
import { apiSuccess, apiFail, handleApiError } from '@web/lib/response';

const CREDITS_TO_YUAN = 0.1; // 1 元 = 10 积分
const MIN_YUAN = 1;
const MAX_YUAN = 10000;
const IDEMPOTENCY_KEY_MAX = 128;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
): Promise<Response> {
  try {
    const admin = await requireAdmin();
    const { userId: targetUserId } = await params;

    const body = (await req.json().catch(() => ({}))) as {
      amountYuan?: unknown;
      note?: unknown;
      idempotencyKey?: unknown;
    };
    const amountYuan = Number(body.amountYuan);
    if (!Number.isFinite(amountYuan)) {
      return apiFail({ error: 'amountYuan 必须为有效数字', code: 'BAD_AMOUNT' }, 400);
    }
    if (amountYuan < MIN_YUAN) {
      return apiFail({ error: `充值金额不能少于 ${MIN_YUAN} 元`, code: 'BAD_AMOUNT' }, 400);
    }
    if (amountYuan > MAX_YUAN) {
      return apiFail({ error: `单次充值金额不能超过 ${MAX_YUAN} 元`, code: 'BAD_AMOUNT' }, 400);
    }

    // idempotencyKey：可选，前端表单每次提交生成 UUID。校验类型/长度后透传给 creditManual。
    const rawKey = body.idempotencyKey;
    const idempotencyKey =
      typeof rawKey === 'string' && rawKey.trim().length > 0 && rawKey.length <= IDEMPOTENCY_KEY_MAX
        ? rawKey.trim()
        : undefined;

    const rechargeCredits = Math.round(amountYuan / CREDITS_TO_YUAN);
    const note =
      typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;
    const description = note
      ? `管理员充值 ¥${amountYuan}（备注：${note}）`
      : `管理员充值 ¥${amountYuan}`;
    const entry = await creditManual(targetUserId, rechargeCredits, description, {
      adminUserId: admin.userId,
      note,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    return apiSuccess({
      credits: entry.balance,
      rechargeCredits,
      ledgerId: entry.id,
    });
  } catch (err) {
    return handleApiError(err, 'POST /api/admin/users/[userId]/recharge');
  }
}
