export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

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
