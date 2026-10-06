import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectInstaller, dateVersion, installerName, parseDateVersion, planNightly, publishNightly, validateArtifacts } from '../scripts/nightly.mjs';

const sha = 'a'.repeat(40), other = 'b'.repeat(40), version = '2026.10.5';
const now = new Date('2026-10-04T19:17:00Z'), builtAt = now.toISOString();
const body = `<!-- aralebook-nightly-source:${sha} -->\n<!-- aralebook-nightly-built-at:${builtAt} -->`;
function release(v, commit = sha) { return { tag_name:`nightly-${v}`, draft:false, prerelease:true, body:`<!-- aralebook-nightly-source:${commit} -->`, assets:['windows-x64','macos-arm64'].map(t => ({name:installerName(v,t),size:10})) }; }

test('nightly uses the Hong Kong calendar date without leading zeroes', () => {
  assert.equal(dateVersion(now), version);
  assert.equal(dateVersion(new Date('2026-12-31T16:00:00Z')), '2027.1.1');
  assert.equal(parseDateVersion('2028.2.29'), 20280229);
  for (const bad of ['2026.02.5','2026.2.29','2026.4.31','2026.13.1','2026.10.5+foo']) assert.equal(parseDateVersion(bad), null);
});

test('only unpublished source builds; an existing daily release is immutable', () => {
  assert.equal(planNightly({sha, now, releases:[]}).shouldBuild, true);
  assert.equal(planNightly({sha, now, releases:[release('2026.10.4')]}).shouldBuild, false);
  assert.equal(planNightly({sha:other, now, releases:[release('2026.10.4')]}).shouldBuild, true);
  assert.equal(planNightly({sha:other, now, releases:[release(version)]}).shouldBuild, false);
  const incomplete = release('2026.10.4'); incomplete.assets.pop();
  assert.equal(planNightly({sha, now, releases:[incomplete]}).shouldBuild, true);
  const stable = release('2026.10.4'); stable.prerelease = false;
  assert.equal(planNightly({sha, now, releases:[stable]}).shouldBuild, true);
});

test('failed publishing resumes the frozen draft even when main has moved', () => {
  const draft = {tag_name:`nightly-${version}`,draft:true,body};
  const plan = planNightly({sha:other, now, releases:[draft]});
  assert.equal(plan.sha, sha); assert.equal(plan.builtAt, builtAt);
  assert.throws(() => planNightly({sha,now,releases:[{...draft,body:''}]}), /缺少构建信息/);
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(),'aralebook-nightly-'));
  t.after(() => rmSync(directory,{recursive:true,force:true}));
  for (const target of ['windows-x64','macos-arm64']) {
    const name = installerName(version,target), data = Buffer.from(target);
    writeFileSync(join(directory,name), data);
    writeFileSync(join(directory,`build-${target}.json`),JSON.stringify({channel:'nightly',version,commit:sha,builtAt,enginesCommit:other,target,name,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')}));
  }
  return {directory,version,sha,builtAt};
}

test('both platform artifacts must match source, engine revision and checksums', t => {
  const args = fixture(t);
  const result = validateArtifacts(args);
  assert.equal(result.files.length,4);
  assert.equal(result.manifest.installers['macos-arm64'].name,installerName(version,'macos-arm64'));
  const sums = readFileSync(join(args.directory,'SHA256SUMS.txt'),'utf8');
  assert.match(sums,/build-info.json/);
  writeFileSync(join(args.directory,installerName(version,'macos-arm64')),'tampered');
  assert.throws(() => validateArtifacts(args),/checksum mismatch/);
});

test('missing platform metadata prevents all remote publication operations', async t => {
  const args = fixture(t);
  rmSync(join(args.directory,'build-macos-arm64.json'));
  await assert.rejects(publishNightly({...args,github:{},owner:'owner',repo:'repo'}),/ENOENT/);
});

function githubMock({failUpload = false, wrongTag = false} = {}) {
  const operations = [], assets = [];
  const missing = async () => { throw Object.assign(new Error('not found'),{status:404}); };
  const github = {rest:{git:{
    getRef: wrongTag ? async () => ({data:{object:{sha:other,type:'commit'}}}) : missing,
    createRef: async args => {operations.push(['tag',args.sha]);},
  },repos:{
    getReleaseByTag:missing,
    createRelease:async args => {operations.push(['create',args.draft]);return {data:{...args,id:1,assets}};},
    deleteReleaseAsset:async () => {},
    uploadReleaseAsset:async args => { if(failUpload && assets.length === 1) throw new Error('upload interrupted'); assets.push({name:args.name,size:args.data.length});operations.push(['upload',args.name]); },
    listReleaseAssets:async () => {},
    updateRelease:async args => {operations.push(['publish',args.draft,args.make_latest]);return {data:args};},
  }},paginate:async () => assets};
  return {github,operations};
}

test('upload failure leaves a draft and never exposes an incomplete release', async t => {
  const args = fixture(t), mock = githubMock({failUpload:true});
  await assert.rejects(publishNightly({...args,...mock,owner:'owner',repo:'repo'}),/upload interrupted/);
  assert.deepEqual(mock.operations[1],['create',true]);
  assert.equal(mock.operations.some(op => op[0] === 'publish'),false);
});

test('complete publication uploads four assets before making a prerelease public', async t => {
  const args = fixture(t), mock = githubMock();
  await publishNightly({...args,...mock,owner:'owner',repo:'repo'});
  assert.equal(mock.operations.filter(op => op[0] === 'upload').length,4);
  assert.deepEqual(mock.operations.at(-1),['publish',false,'false']);
});

test('a nightly tag is never moved to a different commit', async t => {
  const args = fixture(t), mock = githubMock({wrongTag:true});
  await assert.rejects(publishNightly({...args,...mock,owner:'owner',repo:'repo'}),/different source/);
  assert.equal(mock.operations.length,0);
});

function collectionFixture(t) {
  const workspace = mkdtempSync(join(tmpdir(), 'aralebook-collect-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  for (const cwd of [workspace, join(workspace, 'engines')]) {
    mkdirSync(cwd, { recursive: true });
    git(cwd, 'init', '--quiet');
    writeFileSync(join(cwd, 'source.txt'), 'committed source\n');
    git(cwd, 'add', 'source.txt');
    git(cwd, '-c', 'user.name=Nightly test', '-c', 'user.email=nightly-test@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  }
  writeFileSync(join(workspace, '.gitignore'), 'src-tauri/permissions/autogenerated/\n');
  git(workspace, 'add', '.gitignore');
  git(workspace, '-c', 'user.name=Nightly test', '-c', 'user.email=nightly-test@example.invalid', 'commit', '--quiet', '-m', 'ignore generated permissions');
  const bundle = join(workspace, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, `ARaLeBook_${version}_x64-setup.exe`), 'installer fixture');
  const saved = { CI: process.env.CI, ARALE_BUILD_TARGET: process.env.ARALE_BUILD_TARGET };
  process.env.CI = 'true';
  delete process.env.ARALE_BUILD_TARGET;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return { workspace, output: join(workspace, 'output'), target: 'windows-x64', version, sha: git(workspace, 'rev-parse', 'HEAD'), builtAt };
}

test('CI collection accepts clean tracked source and computes installer identity', t => {
  const args = collectionFixture(t);
  const result = collectInstaller(args);
  assert.equal(result.commit, args.sha);
  assert.equal(result.bytes, Buffer.byteLength('installer fixture'));
  assert.equal(readFileSync(join(args.output, result.name), 'utf8'), 'installer fixture');
});

test('CI collection rejects a modified source file and reports its path', t => {
  const args = collectionFixture(t);
  writeFileSync(join(args.workspace, 'source.txt'), 'uncommitted change\n');
  assert.throws(() => collectInstaller(args), /Tracked source changed[\s\S]*M source\.txt/);
});

test('regenerated Tauri permissions do not count as changed source', t => {
  const args = collectionFixture(t);
  const permissions = join(args.workspace, 'src-tauri', 'permissions', 'autogenerated');
  mkdirSync(permissions, { recursive: true });
  writeFileSync(join(permissions, 'arale_invoke.toml'), 'generated permission\n');
  assert.equal(collectInstaller(args).commit, args.sha);
});
