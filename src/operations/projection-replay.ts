import { readFileSync, writeFileSync } from 'fs';
import { redact } from '../events/redact';
import { logger } from '../logger';

export interface ProjectionEvent {
  id: string;
  type: string;
  tenantId?: string;
  payload: any;
  timestamp: number;
}

export interface ProjectionState {
  version: number;
  data: Record<string, any>;
}

export interface ProjectionReplayInput {
  initialState?: ProjectionState;
  events: ProjectionEvent[];
  tenantId?: string; // If set, enforce tenant isolation
}

export interface ProjectionReplayOutput {
  status: 'success' | 'error';
  before?: ProjectionState;
  after?: ProjectionState;
  diff?: Record<string, { from: any; to: any }>;
  error?: string;
}

export class ProjectionReplayer {
  public replay(input: ProjectionReplayInput): ProjectionReplayOutput {
    try {
      const { events, tenantId } = input;
      const initialState = input.initialState || { version: 0, data: {} };
      
      const before = JSON.parse(JSON.stringify(initialState));
      const state = JSON.parse(JSON.stringify(initialState));
      
      if (!events || events.length === 0) {
        return { status: 'success', before, after: state, diff: {} };
      }

      const sortedEvents = [...events].sort((a, b) => a.timestamp - b.timestamp);
      const seenEvents = new Set<string>();

      for (const event of sortedEvents) {
        if (seenEvents.has(event.id)) {
          logger.warn(`Skipping duplicate event ${event.id}`);
          continue;
        }
        seenEvents.add(event.id);

        if (!event.type) {
           throw new Error(`Unknown schema for event ${event.id}`);
        }

        if (tenantId && event.tenantId && event.tenantId !== tenantId) {
          throw new Error(`Tenant isolation violation: event ${event.id} belongs to ${event.tenantId}, expected ${tenantId}`);
        }

        const redactedPayload = redact(event.payload);

        // Replay logic: merge payload into state.data
        state.data = { ...state.data, ...redactedPayload };
        state.version += 1;
      }

      // Compute diff
      const diff: Record<string, any> = {};
      for (const key of Object.keys(state.data)) {
        if (JSON.stringify(before.data[key]) !== JSON.stringify(state.data[key])) {
          diff[key] = { from: before.data[key], to: state.data[key] };
        }
      }
      for (const key of Object.keys(before.data)) {
        if (!(key in state.data)) {
          diff[key] = { from: before.data[key], to: undefined };
        }
      }

      // auditability
      logger.info('Projection replay completed successfully', {
        eventCount: events.length,
        tenantId,
        resultingVersion: state.version
      });

      return {
        status: 'success',
        before,
        after: state,
        diff
      };
    } catch (err: any) {
      logger.error('Projection replay failed', { error: err.message });
      return {
        status: 'error',
        error: err.message
      };
    }
  }
}

// CLI entry point
export function runCommand(args: string[]) {
  if (args.length < 2) {
    console.error("Usage: ts-node src/operations/projection-replay.ts <input-file> <output-file>");
    process.exit(1);
  }

  const inputFile = args[0];
  const outputFile = args[1];

  let inputData: ProjectionReplayInput;
  try {
    inputData = JSON.parse(readFileSync(inputFile, 'utf-8'));
  } catch (err: any) {
    console.error("Failed to read input file:", err.message);
    process.exit(1);
  }

  const replayer = new ProjectionReplayer();
  const result = replayer.replay(inputData);

  writeFileSync(outputFile, JSON.stringify(result, null, 2));
  console.log(`Replay complete. Results written to ${outputFile}`);
}

if (require.main === module) {
  runCommand(process.argv.slice(2));
}
