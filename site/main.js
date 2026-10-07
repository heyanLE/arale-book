import snapshot from './release-snapshot.json';

const repository = 'https://github.com/heyanLE/arale-book';
const releaseList = `${repository}/releases`;
const root = document.documentElement;
const themeToggle = document.getElementById('theme-toggle');
const updateThemeLabel = () => themeToggle.setAttribute('aria-label', root.dataset.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
updateThemeLabel();
themeToggle.addEventListener('click', () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('aralebook-site-theme', root.dataset.theme); } catch { /* The toggle works without persistent storage. */ }
  updateThemeLabel();
});

const header = document.querySelector('.site-header');
const menuToggle = document.getElementById('menu-toggle');
const setMenu = open => {
  header.classList.toggle('menu-is-open', open);
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? '收起导航' : '展开导航');
};
menuToggle.addEventListener('click', () => setMenu(menuToggle.getAttribute('aria-expanded') !== 'true'));
document.querySelectorAll('.site-nav a').forEach(link => link.addEventListener('click', () => setMenu(false)));
matchMedia('(min-width: 761px)').addEventListener('change', event => { if (event.matches) setMenu(false); });

const wordTrigger = document.getElementById('word-trigger');
const explanation = document.getElementById('word-explanation');
const setWord = open => {
  explanation.hidden = !open;
  wordTrigger.setAttribute('aria-expanded', String(open));
  if (open) explanation.dataset.placement = innerHeight - wordTrigger.getBoundingClientRect().bottom < explanation.offsetHeight + 18 ? 'above' : 'below';
};
wordTrigger.addEventListener('click', () => setWord(explanation.hidden));
document.getElementById('word-close').addEventListener('click', () => { setWord(false); wordTrigger.focus(); });
document.addEventListener('click', event => { if (!event.target.closest('.reading-sample')) setWord(false); });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (header.classList.contains('menu-is-open')) { setMenu(false); menuToggle.focus(); }
  if (!explanation.hidden) { setWord(false); wordTrigger.focus(); }
});

const dateLabel = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: 'long', day: 'numeric' }).format(date);
};
const safeReleaseUrl = release => {
  try {
    const url = new URL(release.html_url);
    if (url.origin === 'https://github.com' && url.pathname.startsWith('/heyanLE/arale-book/releases/tag/')) return url.href;
  } catch { /* Invalid data falls back to the release list. */ }
  return releaseList;
};
const hasInstallers = release => Array.isArray(release.assets) &&
  release.assets.some(asset => asset.size > 0 && /^ARaLeBook_.*windows-x64-setup\.exe$/i.test(asset.name)) &&
  release.assets.some(asset => asset.size > 0 && /^ARaLeBook_.*macos-arm64\.dmg$/i.test(asset.name));

function renderReleases(releases, { isSnapshot = false } = {}) {
  const sorted = releases.filter(release => !release.draft && release.published_at && hasInstallers(release))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  const nightly = sorted.find(release => release.prerelease && /^nightly-\d{4}\.\d{1,2}\.\d{1,2}$/.test(release.tag_name));
  const stable = sorted.find(release => !release.prerelease);
  if (nightly) {
    document.getElementById('nightly-version').textContent = nightly.tag_name.replace('nightly-', '');
    document.getElementById('nightly-status').textContent = `${dateLabel(nightly.published_at)}发布 · Windows / macOS`;
    document.getElementById('nightly-link').href = safeReleaseUrl(nightly);
  } else {
    document.getElementById('nightly-version').textContent = '查看每夜构建';
    document.getElementById('nightly-status').textContent = '在 GitHub 查看可用的每夜构建。';
    document.getElementById('nightly-link').href = releaseList;
  }
  if (stable) {
    document.getElementById('stable-version').textContent = stable.tag_name;
    document.getElementById('stable-status').textContent = `${dateLabel(stable.published_at)}发布 · Windows / macOS`;
    const link = document.getElementById('stable-link');
    link.href = safeReleaseUrl(stable);
    link.firstChild.textContent = '打开正式构建';
  } else {
    const hasStableRecord = releases.some(release => !release.draft && !release.prerelease && release.published_at);
    document.getElementById('stable-version').textContent = hasStableRecord ? '正式版暂无完整安装包' : isSnapshot || releases.length < 100 ? '正式版暂未发布' : '暂未找到正式构建';
    document.getElementById('stable-status').textContent = '可以先体验每夜构建，或查看发布记录。';
    const link = document.getElementById('stable-link');
    link.href = releaseList;
    link.firstChild.textContent = '查看发布记录';
  }
}

renderReleases(snapshot.releases, { isSnapshot: true });
const releaseNotice = document.getElementById('release-notice');
const controller = new AbortController();
const requestTimeout = setTimeout(() => controller.abort(), 6000);
try {
  const response = await fetch('https://api.github.com/repos/heyanLE/arale-book/releases?per_page=100', {
    headers: { Accept: 'application/vnd.github+json' }, signal: controller.signal,
  });
  if (!response.ok) throw new Error(`GitHub release status ${response.status}`);
  const releases = await response.json();
  if (!Array.isArray(releases)) throw new Error('Invalid release list');
  renderReleases(releases);
} catch {
  releaseNotice.textContent = `暂时无法检查新版本，当前展示 ${snapshot.checkedAt} 核对的发布信息。最新版本请以 GitHub Release 页面为准。`;
} finally { clearTimeout(requestTimeout); }
