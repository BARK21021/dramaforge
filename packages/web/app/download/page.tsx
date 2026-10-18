// app/download/page.tsx — 浏览器访问提示页
//
// 当普通浏览器（非 Electron 客户端）访问任何页面时，middleware 会 302 重定向到
// 本页。固定下载入口 https://your-domain.example.com/downloads 始终指向最新版（服务器侧
// 维护 latest 软链）。服务端组件，无需客户端 JS。
export default function DownloadPage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 24,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
        background: '#0b0d12',
        color: '#e6e8eb',
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: 28, margin: 0, fontWeight: 600 }}>请使用桌面客户端</h1>
      <p style={{ margin: 0, fontSize: 16, color: '#9aa0a8', maxWidth: 480 }}>
        DramaForge Studio 需通过桌面客户端访问，不支持浏览器直接使用。
      </p>
      <a
        href="https://your-domain.example.com/downloads"
        style={{
          marginTop: 8,
          padding: '12px 28px',
          fontSize: 16,
          fontWeight: 600,
          color: '#0b0d12',
          background: '#e6e8eb',
          borderRadius: 8,
          textDecoration: 'none',
        }}
      >
        下载客户端（Windows）
      </a>
      <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
        下载后双击安装，使用账号登录即可。
      </p>
    </main>
  );
}