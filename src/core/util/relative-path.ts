export function normalizeRel(raw: string): string {
  const forward = raw.replace(/\\/g, '/');
  return forward.startsWith('/') ? forward.slice(1) : forward;
}
