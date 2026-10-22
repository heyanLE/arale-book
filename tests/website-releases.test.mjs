import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReleaseSnapshot, selectReleases, safeReleaseUrl, releaseList } from '../site/releases.mjs';
import { updateSiteReleases } from '../scripts/update-site-releases.mjs';

function release(tag, published, patch = {}) {
  return { tag_name: tag, published_at: published, draft: false, prerelease: true,
    html_url: `https://github.com/heyanLE/arale-book/releases/tag/${tag}`,
    assets: [{name:'ARaLeBook_test_windows-x64-setup.exe',size:123}, {name:'ARaLeBook_test_macos-arm64.dmg',size:456}], ...patch };
}
const older = release('nightly-2026.10.7','2026-10-06T23:16:28Z');
const latest = release('nightly-2026.10.22','2026-10-21T22:28:56Z');

test('published complete Nightly wins regardless of input order or old bundled snapshot', () => {
  const result=selectReleases([latest,older]);
  assert.equal(result.nightly.tag_name,'nightly-2026.10.22');
  assert.equal(selectReleases([older,latest]).nightly.tag_name,result.nightly.tag_name);
});

test('draft, incomplete, invalid-date and outside-repository releases cannot replace latest', () => {
  const candidates=[
    release('nightly-2026.10.23','2026-10-22T22:00:00Z',{assets:[latest.assets[0]]}),
    release('nightly-2026.10.24','2026-10-23T22:00:00Z',{draft:true}),
    release('nightly-2026.10.25','invalid'),
    release('nightly-2026.10.26','2026-10-25T22:00:00Z',{html_url:'https://example.invalid/releases/tag/latest'}),
    release('nightly-2026.10.27','2026-10-26T22:00:00Z',{assets:[latest.assets[0],{...latest.assets[1],size:0}]}),
  ];
  assert.equal(selectReleases([older,...candidates,latest]).nightly.tag_name,latest.tag_name);
  assert.equal(safeReleaseUrl(candidates[3]),releaseList);
});

test('snapshot selects both channels and contains only public website fields', () => {
  const stable=release('v1.0.0','2026-10-20T12:00:00Z',{prerelease:false,body:'not-needed',author:{login:'not-needed'}});
  const snapshot=createReleaseSnapshot([older,latest,stable],new Date('2026-10-21T23:30:00Z'));
  assert.equal(snapshot.checkedAt,'2026-10-22');
  assert.deepEqual(snapshot.releases.map(r=>r.tag_name),[latest.tag_name,stable.tag_name]);
  assert.equal(snapshot.releases[1].body,undefined);
  assert.equal(snapshot.releases[1].author,undefined);
  assert.equal(snapshot.releases[1].prerelease,false);
});

test('incomplete stable publication remains distinguishable from no stable release', () => {
  const partial=release('v1.0.0','2026-10-20T12:00:00Z',{prerelease:false,assets:[latest.assets[0]]});
  const snapshot=createReleaseSnapshot([latest,partial]);
  assert.equal(selectReleases(snapshot.releases).stable,undefined);
  assert.ok(snapshot.releases.some(r=>!r.prerelease && r.published_at));
});

test('build snapshot uses paginated API data instead of its checked-in fallback', async () => {
  const root=await mkdtemp(join(tmpdir(),'arale-site-'));
  const destination=join(root,'snapshot.json');
  const listReleases=()=>{};
  try {
    await writeFile(destination,JSON.stringify({releases:[older]}));
    const github={rest:{repos:{listReleases}},paginate:async(method,args)=>{
      assert.equal(method,listReleases);assert.deepEqual(args,{owner:'owner',repo:'repo',per_page:100});
      return [latest,older];
    }};
    await updateSiteReleases({github,owner:'owner',repo:'repo',destination,now:new Date('2026-10-21T23:30:00Z')});
    const saved=JSON.parse(await readFile(destination,'utf8'));
    assert.equal(saved.releases[0].tag_name,latest.tag_name);
    assert.equal(saved.checkedAt,'2026-10-22');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('API failure does not silently overwrite the snapshot with empty or stale metadata', async () => {
  const root=await mkdtemp(join(tmpdir(),'arale-site-'));
  const destination=join(root,'snapshot.json');
  try {
    await writeFile(destination,'original');
    const github={rest:{repos:{listReleases:()=>{}}},paginate:async()=>{throw new Error('API unavailable');}};
    await assert.rejects(updateSiteReleases({github,owner:'owner',repo:'repo',destination}),/API unavailable/);
    assert.equal(await readFile(destination,'utf8'),'original');
    assert.throws(()=>createReleaseSnapshot({}),/Invalid release list/);
  } finally {await rm(root,{recursive:true,force:true});}
});
