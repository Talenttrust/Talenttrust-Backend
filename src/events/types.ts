export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface EventEnvelope<TPayload extends JsonValue = JsonValue> {
  id: string;
  type: string;
  payload: TPayload;
}

export interface IdempotentEventResult<TResult> {
  result: TResult;
  replayed: boolean;
  payloadHash: string;
}

export interface ContractEvent {
  contractId: string;
  eventId: string;
  sequence: number;
  timestamp: number;
  payload: Record<string, any>;
  signature?: string;
}

export interface EventIngestionResult {
  deduplicationKey: string;
  status: 'accepted' | 'rejected' | 'duplicate';
  reason?: string;
  processedAt: Date;
  statusCode?: number;
  code?: string;
}

export interface EventProcessingAudit {
  id: string;
  deduplicationKey: string;
  contractId: string;
  eventId: string;
  sequence: number;
  status: 'accepted' | 'rejected' | 'duplicate';
  reason?: string;
  payloadHash: string;
  processedAt: Date;
  createdAt: Date;
}

export interface EventValidationError {
  field: string;
  message: string;
  value: any;
}

export interface ValidationResult {
  isValid: boolean;
  errors: EventValidationError[];
}
