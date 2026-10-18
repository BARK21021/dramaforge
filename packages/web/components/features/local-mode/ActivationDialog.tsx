'use client';

import { useState, useEffect } from 'react';
import { Modal } from "@web/components/ui/Modal";
import { Button } from "@web/components/ui/Button";
import { Input } from "@web/components/ui/Input";
import { Spinner } from "@web/components/ui/Spinner";

/**
 * First-run license activation dialog.
 * Shows when no valid license is found on the machine.
 *
 * Activation code format: SF-XXXX-XXXX-XXXX-XXXX
 */
export function ActivationDialog({ open, onSuccess }: {
  open: boolean;
  onSuccess?: () => void;
}) {
  const [code, setCode] = useState('');
  const [machineId, setMachineId] = useState('');
  const [machineIdShort, setMachineIdShort] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      fetch('/api/license/status')
        .then(r => r.json())
        .then(res => {
          if (res.success?.data) {
            setMachineId(res.data.machineId ?? '');
            setMachineIdShort(res.data.machineIdShort ?? '');
          }
        })
        .catch(() => {});
    }
  }, [open]);

  const handleActivate = async () => {
    if (!code.trim()) {
      setError('请输入激活码');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim(), machineId }),
      });
      const data = await res.json();
      if (data.success) {
        onSuccess?.();
      } else {
        setError(data.error || '激活失败，请检查激活码');
      }
    } catch {
      setError('网络错误，请重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open={open} onClose={() => {}} maxWidthClassName="max-w-md">
      <div style={{ textAlign: 'center', padding: '24px' }}>
        <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '8px' }}>
          激活 DramaForge Local
        </h2>
        <p style={{ color: '#666', fontSize: '14px', marginBottom: '24px' }}>
          请输入您的激活码以开始使用。每个激活码绑定一台设备。
        </p>

        <div style={{ marginBottom: '16px' }}>
          <Input
            placeholder="SF-XXXX-XXXX-XXXX-XXXX"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
            style={{ textAlign: 'center', fontFamily: 'monospace', letterSpacing: '1px', fontSize: '18px' }}
          />
        </div>

        {machineIdShort && (
          <p style={{ fontSize: '12px', color: '#999', marginBottom: '16px' }}>
            设备识别码: <code style={{ fontWeight: 600 }}>{machineIdShort}</code>
          </p>
        )}

        {error && (
          <p style={{ color: '#e53e3e', fontSize: '14px', marginBottom: '16px' }}>{error}</p>
        )}

        <Button
          onClick={handleActivate}
          disabled={loading || !code.trim()}
          style={{ width: '100%' }}
        >
          {loading ? <Spinner size={16} /> : '激活'}
        </Button>

        <p style={{ fontSize: '12px', color: '#999', marginTop: '16px' }}>
          激活后，本软件将绑定到当前设备，不可转移。
        </p>
      </div>
    </Modal>
  );
}
