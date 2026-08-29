import { createHmac, timingSafeEqual } from 'node:crypto';

export const API_KEYS_DEFAULT_PAGE_SIZE = 20;
export const API_KEYS_MAX_PAGE_SIZE = 100;

const CURSOR_VERSION = 1;
const CURSOR_MAX_LENGTH = 512;
const CURSOR_SECRET = process.env.API_KEYS_CURSOR_SECRET ?? 'talenttrust-api-keys-cursor-v1';

export interface ApiKeyCursorPosition {
  createdAt: string;
  id: string;
}

interface EncodedApiKeyCursor extends ApiKeyCursorPosition {
  version: number;
}

export interface ApiKeyPage<T> {
  items: T[];
  nextCursor: string | null;
}

export class InvalidApiKeyCursorError extends Error {
  constructor() {
    super('Invalid pagination cursor');
    this.name = 'InvalidApiKeyCursorError';
  }
}

function sign(value: string): string {
  return createHmac('sha256', CURSOR_SECRET).update(value).digest('base64url');
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function encodeApiKeyCursor(position: ApiKeyCursorPosition): string {
  const payload: EncodedApiKeyCursor = {
    version: CURSOR_VERSION,
    createdAt: position.createdAt,
    id: position.id,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function decodeApiKeyCursor(cursor: string): ApiKeyCursorPosition {
  if (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    throw new InvalidApiKeyCursorError();
  }

  const separator = cursor.indexOf('.');
  const encodedPayload = cursor.slice(0, separator);
  const signature = cursor.slice(separator + 1);

  if (!constantTimeEqual(signature, sign(encodedPayload))) {
    throw new InvalidApiKeyCursorError();
  }

  try {
    const decoded = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Partial<EncodedApiKeyCursor>;
    if (
      decoded.version !== CURSOR_VERSION ||
      typeof decoded.createdAt !== 'string' ||
      Number.isNaN(Date.parse(decoded.createdAt)) ||
      typeof decoded.id !== 'string' ||
      decoded.id.length === 0
    ) {
      throw new InvalidApiKeyCursorError();
    }

    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch (error) {
    if (error instanceof InvalidApiKeyCursorError) {
      throw error;
    }
    throw new InvalidApiKeyCursorError();
  }
}

export function parseApiKeyPageSize(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return API_KEYS_DEFAULT_PAGE_SIZE;
  }

  const parsed = typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return API_KEYS_DEFAULT_PAGE_SIZE;
  }

  return Math.min(parsed, API_KEYS_MAX_PAGE_SIZE);
}

function comparePositions<T extends ApiKeyCursorPosition>(left: T, right: T): number {
  const dateDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (dateDifference !== 0) {
    return dateDifference;
  }

  return right.id < left.id ? -1 : right.id > left.id ? 1 : 0;
}

function isAfterCursor<T extends ApiKeyCursorPosition>(item: T, cursor: ApiKeyCursorPosition): boolean {
  const itemTime = Date.parse(item.createdAt);
  const cursorTime = Date.parse(cursor.createdAt);

  return itemTime < cursorTime || (itemTime === cursorTime && item.id < cursor.id);
}

export function paginateApiKeys<T extends ApiKeyCursorPosition>(
  records: readonly T[],
  limit: number,
  cursor?: string,
): ApiKeyPage<T> {
  const boundedLimit = Number.isFinite(limit)
    ? Math.min(Math.max(Math.trunc(limit), 1), API_KEYS_MAX_PAGE_SIZE)
    : API_KEYS_DEFAULT_PAGE_SIZE;
  const sortedRecords = [...records].sort(comparePositions);
  const cursorPosition = cursor === undefined ? undefined : decodeApiKeyCursor(cursor);
  const eligibleRecords = cursorPosition === undefined
    ? sortedRecords
    : sortedRecords.filter((record) => isAfterCursor(record, cursorPosition));
  const page = eligibleRecords.slice(0, boundedLimit);
  const hasMore = eligibleRecords.length > boundedLimit;

  return {
    items: page,
    nextCursor: hasMore && page.length > 0
      ? encodeApiKeyCursor(page[page.length - 1])
      : null,
  };
}
