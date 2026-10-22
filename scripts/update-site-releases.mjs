import { writeFile } from 'node:fs/promises';
import { createReleaseSnapshot } from '../site/releases.mjs';

/** Generate public website metadata at build time, without committing generated data. */
export async function updateSiteReleases({ github, owner, repo, destination, now = new Date() }) {
  const releases = await github.paginate(github.rest.repos.listReleases, { owner, repo, per_page: 100 });
  const snapshot = createReleaseSnapshot(releases, now);
  await writeFile(destination, JSON.stringify(snapshot, null, 2) + '\n');
  return snapshot;
}
