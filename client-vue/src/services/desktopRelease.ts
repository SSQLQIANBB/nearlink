import { ref, computed } from 'vue';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { API_BASE_URL } from '@/utils/api';
import { APP_VERSION } from '@/config/appVersion';

export type DesktopPlatform = 'windows-x64' | 'macos-arm64' | 'macos-x64';
export const platformLabels: Record<DesktopPlatform, string> = {
  'windows-x64': 'Windows · Intel / AMD 64 位',
  'macos-arm64': 'macOS · Apple 芯片',
  'macos-x64': 'macOS · Intel 芯片',
};
export interface DesktopRelease {
  version: string;
  publishedAt: string;
  releaseUrl: string;
  checksumUrl: string;
  assets: Record<DesktopPlatform, { url: string; size: number }>;
}
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/.exec(value);
  const left = parse(a),
    right = parse(b);
  if (!left || !right) return 0;
  const rank: Record<string, number> = { alpha: 0, beta: 1, rc: 2, stable: 3 };
  const parts = (value: RegExpExecArray) => [
    BigInt(value[1]!),
    BigInt(value[2]!),
    BigInt(value[3]!),
    BigInt(rank[value[4] || 'stable']!),
    BigInt(value[5] || 0),
  ];
  const av = parts(left),
    bv = parts(right);
  for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return av[i]! > bv[i]! ? 1 : -1;
  return 0;
}
export function browserPlatform(
  ua: string,
  platform = '',
  touchPoints = 0,
): DesktopPlatform | null {
  if (/Android|iPhone|iPad|iPod/i.test(ua) || (platform === 'MacIntel' && touchPoints > 1))
    return null;
  // Mac UA intentionally hides chip architecture. Never assume Intel from MacIntel.
  if (/Windows/i.test(ua) && /Win64|WOW64|x64/i.test(ua) && !/ARM|aarch64/i.test(ua))
    return 'windows-x64';
  return null;
}
export function validRelease(value: DesktopRelease): boolean {
  if (!value || !/^\d+\.\d+\.\d+-alpha\.\d+$/.test(value.version)) return false;
  const base = `https://github.com/SSQLQIANBB/nearlink/releases/download/desktop-v${value.version}/`;
  const suffixes = {
    'windows-x64': 'x64-setup.exe',
    'macos-arm64': 'aarch64.dmg',
    'macos-x64': 'x64.dmg',
  };
  return Object.entries(suffixes).every(
    ([key, suffix]) =>
      value.assets?.[key as DesktopPlatform]?.url === `${base}NearLink_${value.version}_${suffix}`,
  );
}
export const desktop = isTauri();
export const release = ref<DesktopRelease | null>(null);
export const releaseOpen = ref(false);
export const releaseLoading = ref(false);
export const releaseError = ref('');
export const selectedPlatform = ref<DesktopPlatform | null>(null);
export const installedVersion = ref(APP_VERSION);
export const dismissedVersion = ref('');
export const hasUpdate = computed(
  () =>
    desktop &&
    !!release.value &&
    compareVersions(release.value.version, installedVersion.value) > 0,
);
let lastCheck = 0;
let pending: Promise<void> | null = null;
let identified = false;
export function checkDesktopRelease(force = false): Promise<void> {
  if (pending) return pending;
  if (!force && lastCheck && Date.now() - lastCheck < 6 * 60 * 60_000) return Promise.resolve();
  pending = (async () => {
    releaseLoading.value = true;
    releaseError.value = '';
    try {
      if (!identified) {
        if (desktop) {
          const info = await invoke<{ platform: DesktopPlatform | null; version: string }>(
            'desktop_release_info',
          );
          selectedPlatform.value = info.platform;
          installedVersion.value = info.version;
        } else {
          selectedPlatform.value = browserPlatform(
            navigator.userAgent,
            navigator.platform,
            navigator.maxTouchPoints,
          );
        }
        identified = true;
      }
      const response = await fetch(`${API_BASE_URL}/desktop/release`, {
        signal: AbortSignal.timeout(28_000),
      });
      if (!response.ok) throw new Error('版本服务暂不可用');
      const data = await response.json();
      if (data.release !== null && !validRelease(data.release)) throw new Error('版本信息不完整');
      release.value = data.release;
      lastCheck = Date.now();
    } catch {
      releaseError.value = '暂时无法获取版本，请检查网络后重试。';
      // Do not claim an old cached result is the latest after a failed refresh.
      release.value = null;
    } finally {
      releaseLoading.value = false;
      pending = null;
    }
  })();
  return pending;
}
export function openDesktopRelease() {
  releaseOpen.value = true;
  void checkDesktopRelease(true);
}
export async function downloadDesktopRelease() {
  if (!release.value || !selectedPlatform.value || !validRelease(release.value)) return;
  if (desktop) {
    await invoke('desktop_release_download', {
      version: release.value.version,
      platform: selectedPlatform.value,
    });
  } else {
    const anchor = document.createElement('a');
    anchor.href = release.value.assets[selectedPlatform.value].url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.click();
  }
}

export async function openDesktopReleaseNotes() {
  if (!release.value || !validRelease(release.value)) return;
  if (desktop) {
    await invoke('desktop_release_download', {
      version: release.value.version,
      platform: selectedPlatform.value || 'windows-x64',
      resource: 'notes',
    });
  } else {
    window.open(
      `https://github.com/SSQLQIANBB/nearlink/releases/tag/desktop-v${release.value.version}`,
      '_blank',
      'noopener,noreferrer',
    );
  }
}
