#!/usr/bin/env python3
"""
DramaForge C/S — 不变量守卫 (harness-engineering)
PostToolUse hook (Edit|Write|NotebookEdit)：扫被改内容，违反硬约束就报错并注入修复指令。

硬约束（详见 docs/known-issues/architecture-and-migration.md）：
  H1 媒体资产只存客户端本地 —— packages/server/** 不准入库/落盘媒体字节
  H2 AI key 只在云端服务器    —— packages/client/** 不准出现裸 provider key

策略：明确违规 → exit 2（block，Claude 看到反馈须修）；模糊 → stderr warn + exit 0（不阻断）。
设计原则：永不抛未捕获异常（绝不能因 hook 自身 bug 阻断正常工作）。
"""
import sys, json, re

def _emit(msg):
    # 用显式 UTF-8 字节写 stderr，保证任何 locale（含 GBK 终端）都不因编码抛异常
    try:
        sys.stderr.buffer.write(msg.encode("utf-8", "replace"))
        sys.stderr.buffer.flush()
    except Exception:
        try:
            sys.stderr.write(msg)
        except Exception:
            pass

def warn(msg):
    _emit("⚠ HARNESS GUARD (warn): " + msg + "\n")

def block(msg):
    _emit("❌ HARNESS GUARD (block): " + msg + "\n")
    sys.exit(2)

def main():
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            return
        obj = json.loads(raw)
    except Exception as e:
        # 解析失败绝不阻断
        _emit("⚠ HARNESS GUARD: skip (stdin parse failed: %s)\n" % e)
        return

    tool = obj.get("tool_name", "")
    ti = obj.get("tool_input", {}) or {}
    file_path = ti.get("file_path") or ti.get("notebook_path") or ""
    if not file_path:
        return

    # 取被写入/替换的内容
    if tool == "Write":
        content = ti.get("content", "") or ""
    elif tool == "NotebookEdit":
        content = ti.get("new_source", "") or ""
    else:  # Edit
        content = ti.get("new_string", "") or ""

    norm = file_path.replace("\\", "/").lower()
    is_server = "/packages/server/" in norm
    is_client = "/packages/client/" in norm
    if not (is_server or is_client):
        return

    media_hint = re.search(
        r"(\.mp4|\.mov|\.mkv|\.webm|\.mp3|\.wav|\.m4a|\.aac|\.flac|\.jpg|\.jpeg|\.png|\.webp|\.gif|"
        r"video/|audio/|image/|contenttype[\"'\s:=]+(video|audio|image))",
        content, re.I)
    put_call = re.search(r"\b(putObject|fPutObject|uploadPart|uploadFile|presignedput)\s*\(", content, re.I)
    # minio/s3 客户端的 put/upload（区分大小写敏感的方法名）
    minio_put = re.search(r"\.(putObject|fPutObject|upload|copyObject|uploadPart)\s*\(", content)
    fs_write = re.search(r"\b(createWriteStream|writeFile|writefilesync|appendFile)\b", content, re.I)

    # ---- H1：媒体资产只存客户端本地 ----
    if is_server:
        # 明确违规：对象存储入库 + 媒体上下文
        if minio_put and media_hint:
            block(
                "H1 媒体资产只存客户端本地。检测到 packages/server 内对象存储入库(putObject/upload)+媒体(video/audio/image)上下文。\n"
                "  修复：媒体字节只准存 Electron 客户端本地硬盘(appData/clips)，经 main 进程 IPC 下载；服务器只持 key + DB 元数据，不下载/不转发/不存媒体。\n"
                "  详见 docs/known-issues/architecture-and-migration.md §H1（记忆指针 dramaforge-assets-client-local）。"
            )
        # 明确违规：服务器文件系统落盘媒体
        if fs_write and media_hint:
            block(
                "H1 媒体资产只存客户端本地。检测到 packages/server 内 fs 写盘 + 媒体扩展名/MIME。\n"
                "  修复：媒体不落服务器磁盘，改由客户端下载到本地。详见 docs/known-issues/architecture-and-migration.md §H1。"
            )
        # 模糊：对象存储入库但无明确媒体上下文（可能是元数据）→ warn
        if minio_put and not media_hint:
            warn(
                "H1 提醒：packages/server 出现对象存储入库调用。若这是媒体字节即违反 H1（只准元数据/非媒体）。"
                "  自检无误后忽略；详见 docs/known-issues/architecture-and-migration.md §H1。"
            )

    # ---- H2：AI key 只在云端服务器 ----
    if is_client:
        # 裸 provider key 字面量（sk-... / 长 hex-base 串 赋给 KEY 变量）
        key_literal = re.search(
            r"\b([A-Z0-9_]*API[_]?KEY|[A-Z0-9_]*SECRET|[A-Z0-9_]*TOKEN)\b\s*[:=]\s*['\"]"
            r"(sk-[A-Za-z0-9]{8,}|[A-Za-z0-9_-]{24,})['\"]", content, re.I)
        sk_bare = re.search(r"['\"]sk-[A-Za-z0-9]{16,}['\"]", content)
        if key_literal or sk_bare:
            block(
                "H2 AI key 只在云端服务器。检测到 packages/client 内裸 provider key 字面量。\n"
                "  修复：key 是平台云端服务器的，客户端不准持有（无 BYOK）。调 AI 走服务器路由用 server-side key，key 不出服务器。\n"
                "  详见 docs/known-issues/architecture-and-migration.md §H2（记忆指针 dramaforge-keys-cloud-server-only）。"
            )
        # 模糊：引入 key 变量名但无字面量 → warn
        if re.search(r"\b(MOONSHOT|DASHSCOPE|ARK|VOLC|OPENAI|ANTHROPIC|FAL|SILICONFLOW|VIDU|SEEDANCE|KIMI)[A-Z_]*API[_]?KEY\b", content):
            warn(
                "H2 提醒：packages/client 出现 provider key 变量名。本地无法真生成（只结构/契约验），key 必须只在云端。"
                "  若仅占位/mock 无妨；详见 docs/known-issues/architecture-and-migration.md §H2。"
            )

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        # 兜底：hook 自身任何异常都不阻断工作
        _emit("⚠ HARNESS GUARD: skip (internal error: %s)\n" % e)
