export const repository = 'https://github.com/heyanLE/arale-book';
export const releaseList = `${repository}/releases`;
const windowsInstaller = /^ARaLeBook_.*windows-x64-setup\.exe$/i;
const macInstaller = /^ARaLeBook_.*macos-arm64\.dmg$/i;

export function safeReleaseUrl(release) {
  try {
    const url = new URL(release.html_url);
    if (url.origin === 'https://github.com' && !url.username && !url.password &&
        url.pathname.startsWith('/heyanLE/arale-book/releases/tag/')) return url.href;
  } catch { /* Invalid data falls back to the release list. */ }
  return releaseList;
}

export function hasInstallers(release) {
  return Array.isArray(release.assets) &&
    release.assets.some(asset => asset.size > 0 && windowsInstaller.test(asset.name)) &&
    release.assets.some(asset => asset.size > 0 && macInstaller.test(asset.name));
}

export function selectReleases(releases) {
  const sorted = releases.filter(release => !release.draft && release.published_at &&
    Number.isFinite(Date.parse(release.published_at)) && hasInstallers(release) && safeReleaseUrl(release) !== releaseList)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  return {
    nightly: sorted.find(release => release.prerelease && /^nightly-\d{4}\.\d{1,2}\.\d{1,2}$/.test(release.tag_name)),
    stable: sorted.find(release => !release.prerelease),
  };
}

export function createReleaseSnapshot(releases, now = new Date()) {
  if (!Array.isArray(releases)) throw new Error('Invalid release list');
  const selected = selectReleases(releases);
  // Retain evidence of an incomplete stable release, so the fallback UI does not
  // incorrectly claim no stable release has ever been published.
  const stableRecord = selected.stable ?? releases.filter(release => !release.draft && !release.prerelease &&
    release.published_at && Number.isFinite(Date.parse(release.published_at)) && safeReleaseUrl(release) !== releaseList)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  const records = [selected.nightly, stableRecord].filter(Boolean).map(release => ({
    draft: false,
    published_at: release.published_at,
    assets: release.assets.filter(asset => asset.size > 0 && (windowsInstaller.test(asset.name) || macInstaller.test(asset.name)))
      .map(asset => ({ name: asset.name, size: asset.size })),
    prerelease: release.prerelease,
    tag_name: release.tag_name,
    html_url: safeReleaseUrl(release),
  }));
  return {
    releases: records,
    checkedAt: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now),
  };
}
