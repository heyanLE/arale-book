import lockfile from 'proper-lockfile';
import { readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve } from 'node:path';

/** Heartbeat leases survive PID reuse and hostname changes when containers are recreated. */
export async function acquireLock(root: string, wait = false): Promise<() => Promise<void>> {
    const path = resolve(root, 'runtime.lock');
    // Old versions used a non-empty PID directory. Only migrate a provably dead
    // local owner; never remove a live or unverifiable legacy server's lock.
    try {
        await readFile(resolve(path, 'owner.json'), 'utf8');
        const endMigration = await lockfile.lock(root, {lockfilePath:resolve(root,'runtime-upgrade.lock'),stale:15000,update:5000});
        try {
            // Re-read under a separate migration lease: two starting processes
            // must never remove the normal lease created by the other upgrader.
            const owner = JSON.parse(await readFile(resolve(path, 'owner.json'), 'utf8'));
            let dead = false;
            if (owner.host === hostname() && Number.isInteger(owner.pid)) {
                try { process.kill(owner.pid, 0); }
                catch (error: any) { dead = error.code === 'ESRCH'; }
            }
            if (!dead) throw new Error('This data directory is already used by another Arale server (legacy lock)');
            await rm(path, { recursive: true });
        } finally { await endMigration(); }
    } catch (error: any) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    try {
        return await lockfile.lock(root, {
            lockfilePath: path,
            stale: 15000,
            update: 5000,
            retries: wait ? { retries: 20, factor: 1, minTimeout: 1000, maxTimeout: 1000 } : 0,
        });
    } catch (error: any) {
        if (error.code === 'ELOCKED') throw new Error('This data directory is already used by another Arale server');
        throw error;
    }
}
