export interface AppBuildInfo {
  version: string;
  channel: 'dev' | 'nightly' | 'release';
  commit: string | null;
  builtAt: string | null;
  platform: string;
  arch: string;
}

export interface AppUpdateResult {
  status: 'available' | 'latest' | 'unpublished' | 'disabled' | 'unsupported';
  version: string | null;
  tag: string | null;
}
