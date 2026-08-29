/**
 * Queue Module Entry Point
 * 
 * Exports the main queue functionality for use throughout the application.
 */

export { QueueManager } from './queue-manager';
export {
	JobType,
	JobPayload,
	JobResult,
	JobEnqueueOptions,
	FailedJobEntry,
	FailedJobQuery,
	ReplayJobResult,
	AddJobOptions,
	AddJobResult,
} from './types';
export {
	PriorityLevel,
	DEFAULT_TENANT_ID,
	DEFAULT_FAIR_WEIGHTS,
	DEFAULT_MAX_WAIT_MS,
	normalizePriority,
	orderPendingJobs,
	selectNext,
	isOverdue,
} from './fair-scheduler';
export type {
	FairSchedulerConfig,
	PendingJob,
	SchedulingDecision,
	SchedulingDecisionKind,
	FairOrdering,
} from './fair-scheduler';
export {
	QUEUE_FAIR_METRIC_NAMES,
	initializeQueueFairMetrics,
	resetQueueFairMetrics,
	recordPriorityAssigned,
	recordSchedulingDecision,
	recordAgedBoost,
	setOverdueWaiting,
} from './queue-metrics';
export { queueConfig, getRedisConfig } from './config';
export {
	WebhookDLQEntry,
	WebhookDLQQuery,
	DLQConfig as WebhookDLQConfig,
	getWebhookDLQStorage,
	clearWebhookDLQInstance,
	initializeDLQMetrics,
	resetDLQMetrics,
} from './webhook-dlq';
export { WEBHOOK_RETRY_POLICY, calculateWebhookRetryDelay } from './webhook-retry-policy';
