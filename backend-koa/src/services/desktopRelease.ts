const repository = 'SSQLQIANBB/nearlink';
const root = `https://github.com/${repository}`;
const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.(0|[1-9]\d*)$/;
const suffixes = {
  'windows-x64': 'x64-setup.exe',
  'macos-arm64': 'aarch64.dmg',
  'macos-x64': 'x64.dmg',
};

export function selectDesktopRelease(releases: unknown) {
  if (!Array.isArray(releases)) throw new Error('Invalid release response');
  const candidates = releases.flatMap((release) => {
    if (release.draft || !release.published_at || typeof release.tag_name !== 'string') return [];
    const version = release.tag_name.replace(/^desktop-v/, '');
    if (
      release.tag_name !== `desktop-v${version}` ||
      !pattern.test(version) ||
      !Array.isArray(release.assets)
    )
      return [];
    const base = `${root}/releases/download/desktop-v${version}/`;
    const assets: Record<string, { url: string; size: number }> = {};
    for (const [platform, suffix] of Object.entries(suffixes)) {
      const name = `NearLink_${version}_${suffix}`;
      const asset = release.assets.find(
        (item) =>
          item.name === name &&
          item.state === 'uploaded' &&
          item.size > 0 &&
          item.browser_download_url === base + name,
      );
      if (!asset) return [];
      assets[platform] = { url: asset.browser_download_url, size: asset.size };
    }
    const checksum = release.assets.find(
      (item) =>
        item.name === 'SHA256SUMS.txt' &&
        item.state === 'uploaded' &&
        item.size > 0 &&
        item.browser_download_url === base + 'SHA256SUMS.txt',
    );
    if (!checksum) return [];
    return [
      {
        version,
        publishedAt: release.published_at,
        releaseUrl: `${root}/releases/tag/desktop-v${version}`,
        checksumUrl: checksum.browser_download_url,
        assets,
      },
    ];
  });
  candidates.sort((a, b) => {
    const av = a.version.match(pattern)!.slice(1).map(BigInt);
    const bv = b.version.match(pattern)!.slice(1).map(BigInt);
    for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return av[i] > bv[i] ? -1 : 1;
    return 0;
  });
  return candidates[0] ?? null;
}

let cached: ReturnType<typeof selectDesktopRelease> = null;
let expires = 0;
let pending: Promise<typeof cached> | null = null;
let retryAfter = 0;
export async function getDesktopRelease() {
  if (Date.now() < expires) return cached;
  if (pending) return pending;
  if (Date.now() < retryAfter) throw new Error('Release service temporarily unavailable');
  pending = (async () => {
    const releases = [];
    // Include prereleases; /releases/latest excludes our alpha channel.
    for (let page = 1; page <= 3; page++) {
      const response = await fetch(
        `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'NearLink-release-check',
          },
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!response.ok) throw new Error('Release service unavailable');
      const batch = await response.json();
      if (!Array.isArray(batch)) throw new Error('Invalid release response');
      releases.push(...batch);
      if (batch.length < 100) break;
    }
    cached = selectDesktopRelease(releases);
    expires = Date.now() + 10 * 60_000;
    return cached;
  })();
  try {
    return await pending;
  } catch (error) {
    retryAfter = Date.now() + 30_000;
    throw error;
  } finally {
    pending = null;
  }
}
