/** Nightly planning, installer manifests and atomic GitHub publication. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TARGETS = {
  'windows-x64': { triple: 'x86_64-pc-windows-msvc', bundle: 'nsis', extension: '.exe', suffix: 'windows-x64-setup.exe' },
  'macos-arm64': { triple: 'aarch64-apple-darwin', bundle: 'dmg', extension: '.dmg', suffix: 'macos-arm64.dmg' },
};
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePattern = /<!-- aralebook-nightly-source:([0-9a-f]{40}) -->/;
const timePattern = /<!-- aralebook-nightly-built-at:([^\s]+) -->/;

export function parseDateVersion(value) {
  if (typeof value !== 'string' || !/^[2-9]\d{3}\.[1-9]\d?\.[1-9]\d?$/.test(value)) return null;
  const [y, m, d] = value.split('.').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? y * 10000 + m * 100 + d : null;
}

export function dateVersion(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now).map(p => [p.type, p.value]));
  return `${Number(parts.year)}.${Number(parts.month)}.${Number(parts.day)}`;
}

export function installerName(version, target) {
  if (!parseDateVersion(version) || !TARGETS[target]) throw new Error('Invalid nightly version or target');
  return `ARaLeBook_${version}_${TARGETS[target].suffix}`;
}

function publishedNightly(release) {
  const v = release.tag_name?.replace(/^nightly-/, '');
  return release.tag_name === `nightly-${v}` && parseDateVersion(v) && !release.draft && release.prerelease &&
    Object.keys(TARGETS).every(target => release.assets?.some(a => a.name === installerName(v, target) && a.size > 0));
}

export function planNightly({ sha, releases, now = new Date() }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid source commit');
  const version = dateVersion(now);
  const tag = `nightly-${version}`;
  if (releases.some(r => r.tag_name === tag && !r.draft)) return { shouldBuild: false, reason: `${tag} 已经发布，当天不重复发布` };
  const draft = releases.find(r => r.tag_name === tag && r.draft);
  if (draft) {
    // An upload failure may have left an immutable tag/draft. Retry that snapshot.
    const commit = sourcePattern.exec(draft.body ?? '')?.[1];
    const builtAt = timePattern.exec(draft.body ?? '')?.[1];
    if (!commit || !builtAt || !Number.isFinite(Date.parse(builtAt))) throw new Error('当天的 Nightly 草稿缺少构建信息，无法安全恢复');
    return { shouldBuild: true, sha: commit, version, tag, builtAt, reason: '重试当天尚未完成的发布' };
  }
  const latest = releases.filter(publishedNightly).sort((a, b) => parseDateVersion(b.tag_name.slice(8)) - parseDateVersion(a.tag_name.slice(8)))[0];
  if (sourcePattern.exec(latest?.body ?? '')?.[1] === sha) return { shouldBuild: false, reason: '源码与上次成功发布相同，跳过构建' };
  return { shouldBuild: true, sha, version, tag, builtAt: now.toISOString(), reason: '有尚未发布的源码更新' };
}

export async function prepareNightly({ github, owner, repo, sha, now }) {
  const releases = await github.paginate(github.rest.repos.listReleases, { owner, repo, per_page: 100 });
  return planNightly({ sha, releases, now });
}

const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function validateBuild({ version, sha, builtAt }) {
  if (!parseDateVersion(version) || !/^[0-9a-f]{40}$/.test(sha) || !Number.isFinite(Date.parse(builtAt))) throw new Error('Invalid nightly build metadata');
}

export function collectInstaller({ workspace = root, output, target, version, sha, builtAt }) {
  validateBuild({ version, sha, builtAt });
  const config = TARGETS[target];
  if (!config) throw new Error('Unsupported nightly target');
  const triple = process.env.ARALE_BUILD_TARGET;
  if (triple && triple !== config.triple) throw new Error('Build target does not match the requested artifact');
  const bundleDir = join(workspace, 'src-tauri', 'target', ...(triple ? [triple] : []), 'release', 'bundle', config.bundle);
  const candidates = readdirSync(bundleDir).filter(name => name.endsWith(config.extension) && name.includes(`_${version}_`));
  if (candidates.length !== 1) throw new Error(`Expected one ${target} ${version} installer, got ${candidates.length}`);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
  if (commit !== sha) throw new Error('Build source does not match the frozen commit');
  if (process.env.CI) {
    const changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: workspace, encoding: 'utf8' }).trimEnd();
    if (changes) throw new Error(`Tracked source changed during the CI build:\n${changes}`);
  }
  const enginesCommit = execFileSync('git', ['-C', 'engines', 'rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
  const name = installerName(version, target);
  mkdirSync(output, { recursive: true });
  copyFileSync(join(bundleDir, candidates[0]), join(output, name));
  const metadata = { channel: 'nightly', version, commit, builtAt, enginesCommit, target, name, sha256: digest(join(output, name)), bytes: statSync(join(output, name)).size };
  if (!metadata.bytes) throw new Error('Empty installer');
  writeFileSync(join(output, `build-${target}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

export function validateArtifacts({ directory, version, sha, builtAt }) {
  validateBuild({ version, sha, builtAt });
  const installers = {};
  let enginesCommit;
  for (const target of Object.keys(TARGETS)) {
    const metadata = JSON.parse(readFileSync(join(directory, `build-${target}.json`), 'utf8'));
    const name = installerName(version, target);
    if (metadata.channel !== 'nightly' || metadata.version !== version || metadata.commit !== sha || metadata.builtAt !== builtAt || metadata.target !== target || metadata.name !== name || !/^[0-9a-f]{40}$/.test(metadata.enginesCommit)) throw new Error(`Invalid ${target} build identity`);
    if (enginesCommit && enginesCommit !== metadata.enginesCommit) throw new Error('Platform builds use different engine snapshots');
    enginesCommit = metadata.enginesCommit;
    const file = join(directory, name);
    if (metadata.bytes <= 0 || statSync(file).size !== metadata.bytes || digest(file) !== metadata.sha256) throw new Error(`Installer checksum mismatch: ${name}`);
    installers[target] = { name, bytes: metadata.bytes, sha256: metadata.sha256 };
  }
  const manifest = { channel: 'nightly', version, commit: sha, builtAt, enginesCommit, installers };
  writeFileSync(join(directory, 'build-info.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const files = [...Object.values(installers).map(i => i.name), 'build-info.json'];
  writeFileSync(join(directory, 'SHA256SUMS.txt'), files.map(name => `${digest(join(directory, name))}  ${name}\n`).join(''));
  return { manifest, files: [...files, 'SHA256SUMS.txt'] };
}

export async function publishNightly({ github, owner, repo, directory, version, sha, builtAt }) {
  // Verify both complete builds before creating any remote tag/release.
  const { files } = validateArtifacts({ directory, version, sha, builtAt });
  const tag = `nightly-${version}`;
  let ref;
  try { ref = await github.rest.git.getRef({ owner, repo, ref: `tags/${tag}` }); }
  catch (error) { if (error.status !== 404) throw error; }
  if (ref && (ref.data.object.type !== 'commit' || ref.data.object.sha !== sha)) throw new Error('Existing nightly tag points to different source; it will not be moved');
  if (!ref) await github.rest.git.createRef({ owner, repo, ref: `refs/tags/${tag}`, sha });
  let release;
  try { release = (await github.rest.repos.getReleaseByTag({ owner, repo, tag })).data; }
  catch (error) { if (error.status !== 404) throw error; }
  const body = `每夜构建 ${version}（北京时间），来源：[${sha.slice(0, 8)}](https://github.com/${owner}/${repo}/commit/${sha})。\n\n提供 Windows x64 安装包和 macOS Apple Silicon DMG。下载后手动安装，应用和 OCR 引擎分别分发。\n\nWindows 未进行商业证书签名；macOS 使用 ad-hoc 签名，尚未公证。\n\n<!-- aralebook-nightly-source:${sha} -->\n<!-- aralebook-nightly-built-at:${builtAt} -->`;
  if (release && !release.draft) {
    if (sourcePattern.exec(release.body ?? '')?.[1] === sha && files.every(name => release.assets?.some(a => a.name === name && a.size === statSync(join(directory, name)).size))) return release;
    throw new Error('Published nightly releases are immutable');
  }
  if (!release) release = (await github.rest.repos.createRelease({ owner, repo, tag_name: tag, target_commitish: sha, name: `Nightly ${version.split('.').map((v, i) => i ? v.padStart(2, '0') : v).join('-')}`, body, draft: true, prerelease: true, make_latest: 'false' })).data;
  if (sourcePattern.exec(release.body ?? '')?.[1] !== sha) throw new Error('Existing draft belongs to another source commit');
  for (const name of files) {
    const old = release.assets?.find(a => a.name === name);
    if (old) await github.rest.repos.deleteReleaseAsset({ owner, repo, asset_id: old.id });
    const data = readFileSync(join(directory, name));
    await github.rest.repos.uploadReleaseAsset({ owner, repo, release_id: release.id, name, data, headers: { 'content-type': 'application/octet-stream', 'content-length': String(data.length) } });
  }
  const uploaded = await github.paginate(github.rest.repos.listReleaseAssets, { owner, repo, release_id: release.id, per_page: 100 });
  if (!files.every(name => uploaded.some(a => a.name === name && a.size === statSync(join(directory, name)).size))) throw new Error('Uploaded release assets are incomplete; leaving release as a draft');
  return (await github.rest.repos.updateRelease({ owner, repo, release_id: release.id, body, draft: false, prerelease: true, make_latest: 'false' })).data;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'collect') throw new Error('Usage: node scripts/nightly.mjs collect <windows-x64|macos-arm64>');
  const target = process.argv[3];
  try {
    collectInstaller({ output: join(root, '.tmp', 'nightly', target), target, version: process.env.ARALE_BUILD_VERSION, sha: process.env.ARALE_BUILD_COMMIT, builtAt: process.env.ARALE_BUILD_TIME });
  } catch (error) {
    if (process.env.GITHUB_ACTIONS === 'true') {
      const message = String(error.message).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
      console.error(`::error title=Nightly installer validation::${message}`);
    }
    throw error;
  }
}
