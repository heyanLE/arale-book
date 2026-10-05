/** Platform adapter. Protocol code never imports filesystem or Node modules. */
export interface ServiceRuntime {
  readJson<T>(file: string, fallback: T): T;
  writeJsonAtomic(file: string, value: unknown): void;
  hash(algorithm: 'sha256' | 'md5', value: string): string;
  randomHex(bytes: number): string;
  sibling(file: string, name: string): string;
}
