/**
 * Machine fingerprint �� generates a stable hardware ID.
 * Combines CPU model + motherboard UUID + primary disk serial.
 * Works on Windows / macOS / Linux via Node's os module + platform commands.
 */
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import os from 'os';

interface FingerprintComponents {
  cpuId: string;
  boardId: string;
  diskId: string;
  mac: string;
}

function safeExec(cmd: string, encoding: BufferEncoding = 'utf-8'): string {
  try {
    return execSync(cmd, { encoding, timeout: 5000 }).trim();
  } catch {
    return '';
  }
}

function getWindowsFingerprint(): FingerprintComponents {
  // Win11 removed `wmic`; use PowerShell Get-CimInstance (built in since PS3).
  // ponytail: Win32_BaseBoard.SerialNumber is "Default string" on many OEM
  // boards (useless), so use the machine UUID instead — stable + actually unique.
  const cim = (expr: string) =>
    safeExec(`powershell -NoProfile -Command "${expr}"`).replace(/\r/g, '').trim();
  return {
    cpuId: cim('(Get-CimInstance Win32_Processor).ProcessorId'),
    boardId: cim('(Get-CimInstance Win32_ComputerSystemProduct).UUID'),
    diskId: cim('(Get-CimInstance Win32_DiskDrive | Select-Object -First 1).SerialNumber'),
    mac: safeExec('getmac /NH /FO CSV').split(',')[0]?.replace(/"/g, '').trim() ?? '',
  };
}

function getMacFingerprint(): FingerprintComponents {
  return {
    cpuId: safeExec(
      'sysctl -n machdep.cpu.brand_string',
    ),
    boardId: safeExec(
      'ioreg -rd1 -c IOPlatformExpertDevice | awk \'/IOPlatformUUID/ { split($0, line, "\\""); print line[4] }\'',
    ),
    diskId: safeExec(
      'diskutil info disk0 | awk \'/Volume UUID/ {print $3}\'',
    ),
    mac: safeExec(
      'ifconfig en0 | awk \'/ether/ {print $2}\'',
    ),
  };
}

function getLinuxFingerprint(): FingerprintComponents {
  return {
    cpuId: safeExec(
      'cat /proc/cpuinfo | grep -m1 "Serial" | awk \'{print $3}\'',
    ) || safeExec('cat /proc/cpuinfo | grep -m1 "model name" | cut -d: -f2'),
    boardId: safeExec(
      'cat /sys/class/dmi/id/board_serial 2>/dev/null || cat /sys/class/dmi/id/product_uuid 2>/dev/null',
    ),
    diskId: safeExec(
      'lsblk -dno SERIAL /dev/sda 2>/dev/null || lsblk -dno SERIAL /dev/nvme0n1 2>/dev/null',
    ),
    mac: safeExec(
      'cat /sys/class/net/eth0/address 2>/dev/null || cat /sys/class/net/enp*s0/address 2>/dev/null',
    ),
  };
}

let cachedFingerprint: string | null = null;

/** Get raw hardware components. */
export function getFingerprintComponents(): FingerprintComponents {
  const platform = process.platform;
  if (platform === 'win32') return getWindowsFingerprint();
  if (platform === 'darwin') return getMacFingerprint();
  if (platform === 'linux') return getLinuxFingerprint();
  // Fallback: use hostname + MAC
  return {
    cpuId: os.hostname(),
    boardId: '',
    diskId: '',
    mac: Object.values(os.networkInterfaces()).flat().find((i) => i && !i.internal && i.mac !== '00:00:00:00:00:00')?.mac ?? '',
  };
}

/** Generate a stable machine ID (SHA-256, first 32 hex chars). */
export function getMachineId(): string {
  if (cachedFingerprint) return cachedFingerprint;
  const comps = getFingerprintComponents();
  const raw = [comps.cpuId, comps.boardId, comps.diskId].filter(Boolean).join('|');
  if (!raw) {
    // Absolute fallback: hostname + MAC + platform
    const fallback = [os.hostname(), comps.mac, process.platform, os.arch()].join('|');
    cachedFingerprint = createHash('sha256').update(fallback).digest('hex').slice(0, 32);
  } else {
    cachedFingerprint = createHash('sha256').update(raw).digest('hex').slice(0, 32);
  }
  return cachedFingerprint;
}

/** Get a short human-readable machine ID for display (first 8 + last 4). */
export function getMachineIdShort(): string {
  const id = getMachineId();
  return `${id.slice(0, 8)}-${id.slice(-4)}`.toUpperCase();
}