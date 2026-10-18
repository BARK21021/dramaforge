/** 修改密码成功后调用的最小 signOut 形状，便于在 node 环境做契约测试。 */
export type PasswordChangeSignOut = (options: {
  callbackUrl: string;
  redirect: true;
}) => Promise<unknown>;

/**
 * 关闭改密弹窗并清除本机 NextAuth 会话，随后跳转登录页。
 *
 * 后端已经轮换 activeSessionStamp，使所有旧 JWT 失效；这里仍显式 signOut，
 * 用于立即删除浏览器 cookie，避免前端继续显示一个已被服务端撤销的会话。
 */
export async function finishPasswordChange(
  onClose: () => void,
  signOut: PasswordChangeSignOut,
): Promise<void> {
  onClose();
  await signOut({ callbackUrl: '/auth/signin', redirect: true });
}
