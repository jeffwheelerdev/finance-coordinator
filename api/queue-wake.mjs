import { QueueClient } from '@vercel/queue';
import { consumeSchedulerMessage, schedulerRetry, SCHEDULER_REGION } from '../lib/scheduler.mjs';

// Registered as a private queue/v2beta consumer, with no public rewrite.
// Messages can wake the canonical service or read health; never send money here.
const queue = new QueueClient({ region: SCHEDULER_REGION, telemetry: { isEnabled: false } });
export default queue.handleNodeCallback((message, metadata) => consumeSchedulerMessage(message, metadata), {
  visibilityTimeoutSeconds: 300,
  retry: (error, metadata) => schedulerRetry(error, metadata),
});
