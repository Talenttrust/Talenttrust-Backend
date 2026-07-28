import { createHash } from 'crypto';

function normalizeEtag(tag: string): string {
  const trimmed = tag.trim();
  if (trimmed.startsWith('W/')) {
    return trimmed.slice(2);
  }
  return trimmed;
}

export function buildEtag(scope: string, payload: unknown): string {
  const serializedPayload = JSON.stringify(payload);
  const digest = createHash('sha256')
    .update(scope)
    .update(':')
    .update(serializedPayload)
    .digest('base64url');

  return `"${digest}"`;
}

export function isIfNoneMatchSatisfied(
  ifNoneMatchHeader: string | string[] | undefined,
  etag: string
): boolean {
  if (!ifNoneMatchHeader) {
    return false;
  }

  const rawValue = Array.isArray(ifNoneMatchHeader)
    ? ifNoneMatchHeader.join(',')
    : ifNoneMatchHeader;

  const candidateTags = rawValue.split(',').map((value) => value.trim());
  if (candidateTags.includes('*')) {
    return true;
  }

  const normalizedTarget = normalizeEtag(etag);
  return candidateTags.some((candidate) => normalizeEtag(candidate) === normalizedTarget);
}
