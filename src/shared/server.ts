import type { BookRecord, ReadingPosition } from './types';
export const SERVER_API_VERSION = 1;
export interface ServerPage {
    id: string;
    url: string;
    width: number;
    height: number;
    sha256: string;
    bytes: number;
}
export interface ServerBook extends Omit<BookRecord, 'dir' | 'pages'> {
    revision: string;
    pages: ServerPage[];
    ocrRevision: number;
    coverSha256: string;
}
export interface ServerInfo {
    apiVersion: number;
    serverId: string;
    userId: string;
    name: string;
    capabilities: {
        formats: string[];
        ocr: boolean;
        engine: string;
        engineVersion: string;
        catalog?: boolean;
    };
}
export interface ServerConnection {
    id: string;
    serverId: string;
    userId: string;
    name: string;
    url: string;
    hasToken: boolean;
    autoSync?: boolean;
}
export interface ServerConnections {
    activeId: string | null;
    connections: ServerConnection[];
}
export interface ServerConnectionInput {
    id?: string;
    name: string;
    url: string;
    token?: string;
}
export interface RemoteOrigin {
    connectionId: string;
    serverId: string;
    bookId: string;
    revision: string;
    ocrRevision: number;
    coverSha256?: string;
    available?: boolean;
}
export interface ServerPosition {
    revision: number;
    contentRevision: string;
    position: ReadingPosition | null;
    deviceId: string;
}
export interface ServerJob {
    blocks?: number;
    id: string;
    bookId: string;
    revision: string;
    title: string;
    state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    done: number;
    total: number;
    error: string | null;
    createdAt: number;
    updatedAt: number;
    attempt: number;
}
export interface ProgressConflict {
    contentChanged?: boolean;
    bookId: string;
    title: string;
    local: ReadingPosition;
    remote: ReadingPosition | null;
}
export interface ServerScanStatus {connectionId:string;running:boolean;completedAt:number;errors:string[]}
export interface ServerPoll {
    scans?: ServerScanStatus[];
    jobs: ServerJob[];
    conflicts: ProgressConflict[];
    offline: string[];
    connections?: ServerSyncStatus[];
}
export interface ServerSyncStatus {
    connectionId: string;
    autoSync: boolean;
    phase: 'idle' | 'syncing' | 'offline' | 'auth-error' | 'error';
    lastSyncedAt: number | null;
    lastAttemptAt: number | null;
    pending: number;
    conflicts: number;
    catalogRevision: string;
    error: string | null;
}

export interface RemoteDownload {
    bookId: string;
    title: string;
    revision: string;
    status: 'queued' | 'downloading' | 'waiting' | 'paused' | 'failed' | 'complete';
    stage: 'checking' | 'pages' | 'text' | 'done';
    done: number;
    total: number;
    bytesDone: number;
    bytesTotal: number;
    error: string | null;
    updatedAt: number;
    outdated?: boolean;
}
