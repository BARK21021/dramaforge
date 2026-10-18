'use client';

import { useState, useEffect } from 'react';
import { ActivationDialog } from "@web/components/features/local-mode/ActivationDialog";
import { useRouter } from 'next/navigation';

export default function ActivatePage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    // Check if already activated
    fetch('/api/license/status')
      .then(r => r.json())
      .then(res => {
        if (res.success?.data?.valid) {
          router.replace('/');
        } else {
          setChecking(false);
        }
      })
      .catch(() => setChecking(false));
  }, [router]);

  if (checking) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#f5f5f5',
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '24px', fontWeight: 700, marginBottom: '8px' }}>DramaForge Local</div>
          <div style={{ color: '#999' }}>正在检查许可证...</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    }}>
      <div style={{ marginBottom: '40px', textAlign: 'center' }}>
        <h1 style={{ fontSize: '32px', fontWeight: 700, color: 'white', marginBottom: '8px' }}>
          DramaForge Local
        </h1>
        <p style={{ color: 'rgba(255,255,255,0.8)', fontSize: '16px' }}>
          短剧AI创作·本地版
        </p>
      </div>
      <ActivationDialog
        open={true}
        onSuccess={() => router.replace('/')}
      />
    </div>
  );
}
