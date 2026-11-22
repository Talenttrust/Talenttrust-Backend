import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { AuditStore, type AuditSnapshot } from './audit';
import {
  EscrowStore,
  type ChainInfo,
  type ContractRevision,
  type ContractStatus,
  type Dispute,
  type InternalContract,
  type InternalTemplate,
  type ReputationRecord,
  type Review,
  type TemplateMode,
} from './store';

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 30_000;

export interface SerializedMilestone {
  index: number;
  title: string;
  amount: string;
  released: boolean;
}

export interface SerializedContract {
  id: number;
  title: string;
  client: string;
  freelancer: string;
  token: string;
  milestones: SerializedMilestone[];
  totalAmount: string;
  fundedAmount: string;
  releasedAmount: string;
  status: ContractStatus;
  reputationIssued: boolean;
  dispute?: Dispute;
  chain?: ChainInfo;
  revision: number;
  revisions: ContractRevision[];
  version: number;
  templateId?: number;
  templateVersion?: number;
  createdAt: string;
  updatedAt: string;
  fundingDeadline: string;
  expiredAt?: string;
  refundableAmount?: string;
}

export interface SerializedTemplate {
  id: number;
  owner: string;
  name: string;
  description?: string;
  mode: TemplateMode;
  milestones: Array<{ title: string; amount?: string; percentBps?: number }>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoreSnapshot {
  schemaVersion: number;
  savedAt: string;
  contracts: SerializedContract[];
  templates: SerializedTemplate[];
  reputation: Record<string, ReputationRecord>;
  clientReputation: Record<string, ReputationRecord>;
  reviews: Review[];
  counters: {
    nextId: number;
    nextReviewId: number;
    nextTemplateId: number;
  };
  audit: AuditSnapshot;
}

export interface SnapshotPersistenceOptions {
  filePath: string;
  intervalMs?: number;
  onError?: (err: unknown) => void;
}

export interface SnapshotController {
  flush: () => void;
  stop: () => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBigIntField(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new Error(`Corrupt snapshot: "${field}" must be a decimal integer string`);
  }
  return BigInt(value);
}

function assertPositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Corrupt snapshot: "${field}" must be a positive integer`);
  }
  return value;
}

export function serializeStore(store: EscrowStore): StoreSnapshot {
  const state = store.exportState();

  const contracts: SerializedContract[] = state.contracts.map((c) => ({
    id: c.id,
    title: c.title,
    client: c.client,
    freelancer: c.freelancer,
    token: c.token,
    milestones: c.milestones.map((m) => ({
      index: m.index,
      title: m.title,
      amount: m.amount.toString(),
      released: m.released,
    })),
    totalAmount: c.totalAmount.toString(),
    fundedAmount: c.fundedAmount.toString(),
    releasedAmount: c.releasedAmount.toString(),
    status: c.status,
    reputationIssued: c.reputationIssued,
    ...(c.dispute !== undefined ? { dispute: structuredClone(c.dispute) } : {}),
    ...(c.chain !== undefined ? { chain: structuredClone(c.chain) } : {}),
    revision: c.revision,
    revisions: structuredClone(c.revisions),
    version: c.version,
    ...(c.templateId !== undefined ? { templateId: c.templateId } : {}),
    ...(c.templateVersion !== undefined ? { templateVersion: c.templateVersion } : {}),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    fundingDeadline: c.fundingDeadline,
    ...(c.expiredAt !== undefined ? { expiredAt: c.expiredAt } : {}),
    ...(c.refundableAmount !== undefined ? { refundableAmount: c.refundableAmount.toString() } : {}),
  }));

  const templates: SerializedTemplate[] = state.templates.map((t) => ({
    id: t.id,
    owner: t.owner,
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    mode: t.mode,
    milestones: t.milestones.map((m) => ({
      title: m.title,
      ...(m.amount !== undefined ? { amount: m.amount.toString() } : {}),
      ...(m.percentBps !== undefined ? { percentBps: m.percentBps } : {}),
    })),
    version: t.version,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }));

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    contracts,
    templates,
    reputation: structuredClone(state.reputation),
    clientReputation: structuredClone(state.clientReputation),
    reviews: structuredClone(state.reviews),
    counters: {
      nextId: state.nextId,
      nextReviewId: state.nextReviewId,
      nextTemplateId: state.nextTemplateId,
    },
    audit: structuredClone(state.audit),
  };
}

export function restoreStore(store: EscrowStore, snapshot: unknown): void {
  if (!isPlainObject(snapshot)) {
    throw new Error('Corrupt snapshot: root value must be a JSON object');
  }

  const version = snapshot.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error(`Corrupt snapshot: invalid schemaVersion (${String(version)})`);
  }
  if (version > SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported snapshot schemaVersion ${version} (this build supports up to ${SNAPSHOT_SCHEMA_VERSION})`,
    );
  }

  if (!Array.isArray(snapshot.contracts)) {
    throw new Error('Corrupt snapshot: "contracts" must be an array');
  }
  if (!Array.isArray(snapshot.templates)) {
    throw new Error('Corrupt snapshot: "templates" must be an array');
  }
  if (!isPlainObject(snapshot.reputation)) {
    throw new Error('Corrupt snapshot: "reputation" must be an object');
  }
  if (!isPlainObject(snapshot.clientReputation)) {
    throw new Error('Corrupt snapshot: "clientReputation" must be an object');
  }
  if (!Array.isArray(snapshot.reviews)) {
    throw new Error('Corrupt snapshot: "reviews" must be an array');
  }
  if (!isPlainObject(snapshot.counters)) {
    throw new Error('Corrupt snapshot: "counters" must be an object');
  }
  if (!isPlainObject(snapshot.audit)) {
    throw new Error('Corrupt snapshot: "audit" must be an object');
  }

  const nextId = assertPositiveInt(snapshot.counters.nextId, 'counters.nextId');
  const nextReviewId = assertPositiveInt(snapshot.counters.nextReviewId, 'counters.nextReviewId');
  const nextTemplateId = assertPositiveInt(snapshot.counters.nextTemplateId, 'counters.nextTemplateId');

  const contracts: InternalContract[] = snapshot.contracts.map((raw, idx) => {
    if (!isPlainObject(raw)) {
      throw new Error(`Corrupt snapshot: contracts[${idx}] must be an object`);
    }
    if (!Array.isArray(raw.milestones)) {
      throw new Error(`Corrupt snapshot: contracts[${idx}].milestones must be an array`);
    }
    if (!Array.isArray(raw.revisions)) {
      throw new Error(`Corrupt snapshot: contracts[${idx}].revisions must be an array`);
    }
    const milestones = raw.milestones.map((m, mIdx) => {
      if (!isPlainObject(m)) {
        throw new Error(`Corrupt snapshot: contracts[${idx}].milestones[${mIdx}] must be an object`);
      }
      return {
        index: Number(m.index),
        title: String(m.title),
        amount: parseBigIntField(m.amount, `contracts[${idx}].milestones[${mIdx}].amount`),
        released: Boolean(m.released),
      };
    });

    return {
      id: assertPositiveInt(raw.id, `contracts[${idx}].id`),
      title: String(raw.title),
      client: String(raw.client),
      freelancer: String(raw.freelancer),
      token: String(raw.token),
      milestones,
      totalAmount: parseBigIntField(raw.totalAmount, `contracts[${idx}].totalAmount`),
      fundedAmount: parseBigIntField(raw.fundedAmount, `contracts[${idx}].fundedAmount`),
      releasedAmount: parseBigIntField(raw.releasedAmount, `contracts[${idx}].releasedAmount`),
      status: raw.status as ContractStatus,
      reputationIssued: Boolean(raw.reputationIssued),
      ...(raw.dispute !== undefined ? { dispute: structuredClone(raw.dispute as Dispute) } : {}),
      ...(raw.chain !== undefined ? { chain: structuredClone(raw.chain as ChainInfo) } : {}),
      revision: Number(raw.revision),
      revisions: structuredClone(raw.revisions as ContractRevision[]),
      version: Number(raw.version),
      ...(raw.templateId !== undefined ? { templateId: Number(raw.templateId) } : {}),
      ...(raw.templateVersion !== undefined ? { templateVersion: Number(raw.templateVersion) } : {}),
      createdAt: String(raw.createdAt),
      updatedAt: String(raw.updatedAt),
      fundingDeadline: String(raw.fundingDeadline),
      ...(raw.expiredAt !== undefined ? { expiredAt: String(raw.expiredAt) } : {}),
      ...(raw.refundableAmount !== undefined
        ? { refundableAmount: parseBigIntField(raw.refundableAmount, `contracts[${idx}].refundableAmount`) }
        : {}),
    };
  });

  const templates: InternalTemplate[] = snapshot.templates.map((raw, idx) => {
    if (!isPlainObject(raw)) {
      throw new Error(`Corrupt snapshot: templates[${idx}] must be an object`);
    }
    if (!Array.isArray(raw.milestones)) {
      throw new Error(`Corrupt snapshot: templates[${idx}].milestones must be an array`);
    }
    const milestones = raw.milestones.map((m, mIdx) => {
      if (!isPlainObject(m)) {
        throw new Error(`Corrupt snapshot: templates[${idx}].milestones[${mIdx}] must be an object`);
      }
      return {
        title: String(m.title),
        ...(m.amount !== undefined
          ? { amount: parseBigIntField(m.amount, `templates[${idx}].milestones[${mIdx}].amount`) }
          : {}),
        ...(m.percentBps !== undefined ? { percentBps: Number(m.percentBps) } : {}),
      };
    });

    return {
      id: assertPositiveInt(raw.id, `templates[${idx}].id`),
      owner: String(raw.owner),
      name: String(raw.name),
      ...(raw.description !== undefined ? { description: String(raw.description) } : {}),
      mode: raw.mode as TemplateMode,
      milestones,
      version: Number(raw.version),
      createdAt: String(raw.createdAt),
      updatedAt: String(raw.updatedAt),
    };
  });

  const rawAudit = snapshot.audit;
  if (
    !Array.isArray(rawAudit.entries) ||
    typeof rawAudit.prevHash !== 'string' ||
    (rawAudit.truncatedBeforeSeq !== null &&
      (typeof rawAudit.truncatedBeforeSeq !== 'number' || !Number.isInteger(rawAudit.truncatedBeforeSeq)))
  ) {
    throw new Error('Corrupt snapshot: invalid "audit" structure');
  }
  const auditSnapshot: AuditSnapshot = {
    entries: structuredClone(rawAudit.entries),
    nextSeq: assertPositiveInt(rawAudit.nextSeq, 'audit.nextSeq'),
    prevHash: rawAudit.prevHash,
    truncatedBeforeSeq: rawAudit.truncatedBeforeSeq,
  };

  // Validate audit hash chain before mutating the target store.
  const auditVerifier = new AuditStore();
  auditVerifier.loadSnapshot(auditSnapshot);
  const verification = auditVerifier.verify();
  if (!verification.valid) {
    throw new Error(
      `Corrupt snapshot: audit hash chain verification failed at seq ${verification.brokenAt ?? 'unknown'}`,
    );
  }

  store.importState({
    contracts,
    templates,
    reputation: structuredClone(snapshot.reputation as Record<string, ReputationRecord>),
    clientReputation: structuredClone(snapshot.clientReputation as Record<string, ReputationRecord>),
    reviews: structuredClone(snapshot.reviews as Review[]),
    nextId,
    nextReviewId,
    nextTemplateId,
    audit: auditSnapshot,
  });
}

export function writeSnapshotAtomic(filePath: string, store: EscrowStore): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const payload = JSON.stringify(serializeStore(store));
  try {
    fs.writeFileSync(tmpPath, payload, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

export function loadSnapshotFile(filePath: string, store: EscrowStore): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Corrupt snapshot file "${filePath}": invalid JSON (${detail})`);
  }
  restoreStore(store, parsed);
  return true;
}

export function parseSnapshotIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SNAPSHOT_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid STORE_SNAPSHOT_INTERVAL_MS: "${raw}". Must be a positive integer.`);
  }
  return value;
}

export function startSnapshotPersistence(
  store: EscrowStore,
  options: SnapshotPersistenceOptions,
): SnapshotController {
  const intervalMs = options.intervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  const onError =
    options.onError ??
    ((err: unknown) => {
      console.error('Snapshot persistence error:', err instanceof Error ? err.message : err);
    });

  let stopped = false;

  const flush = () => {
    writeSnapshotAtomic(options.filePath, store);
  };

  const timer = setInterval(() => {
    try {
      flush();
    } catch (err) {
      onError(err);
    }
  }, intervalMs);
  timer.unref();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    flush();
  };

  return { flush, stop };
}
