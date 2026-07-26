# Design Notes

Fill this in as part of your submission. We'd rather read a clear, honest
account of a partial fix than a vague description of a complete one. Bullet
points are fine; prose is fine. Aim for signal over length.

## 1. What issues did you find?

I found a series of critical distributed system bugs triggered by concurrency, partial failures, and unbounded background loops:
- **Negative Balances:** `WalletsService.withdraw` was using an insecure "read-modify-write" pattern, allowing race conditions to bypass the zero-balance check. Found via code inspection and the visible test suite.
- **Incomplete Transfer Feature:** `WalletsService.transfer` lacked the RabbitMQ publishing logic necessary to trigger the ledger entry for the recipient. Found via a failing unit test in `wallets.service.spec.ts`.
- **Duplicate Message Delivery:** `TransferEventsConsumer` was purely additive and lacked an idempotency check, meaning retried RabbitMQ messages caused duplicate funds to be credited. Found via code inspection.
- **Dual-Write / Atomicity Gap:** The transfer method updated MongoDB and published to RabbitMQ directly. If RabbitMQ was down or network failed after the DB commit, the transfer would be stuck. Found via architectural review.
- **Cache Inconsistency:** The Redis cache was completely detached from database transactions. Dashboard returned stale balances because the cache wasn't invalidated on withdrawal/deposit/transfer. Found by tracing the caching lifecycle.
- **Dashboard N+1 Query:** `WalletsService.getDashboard` fetched transactions, but mapped over them sequentially with `transferModel.findById()`, leading to massive performance degradation. Found via inspecting `wallets.service.ts`.
- **Stuck Transfers (Missing DLQ):** Failed messages in the RabbitMQ transfer queue were rejected and discarded. There was no Dead Letter Queue or Dead Letter Exchange configured to hold stuck/poison messages. Found via code inspection in `rabbitmq.service.ts`.
- **API Idempotency:** The transfer endpoint didn't track idempotency keys. Network timeouts resulting in client retries caused duplicate debits. Found via `does not create a second transfer when retried` failing test.
- **Memory Leak in Background Worker:** `WalletEventsWorker` bound an unbound anonymous callback to an `EventEmitter` inside an infinite loop, causing heap exhaustion. Found via code review of `src/workers/wallet-events.worker.ts`.
- **Missing Ledger Indexes:** `LedgerService.getLedgerHistory` queried large collections by `walletId` and `createdAt` without compound indexes, causing full collection scans. Found via Mongoose schema review.
- **Fragmented Observability:** Logs lacked a unified trace ID, making it impossible to stitch together a request's lifecycle across HTTP and RabbitMQ logs. Found via log output observation.

## 2. What did you prioritize, and why?

I prioritized severe data corruption and systemic failure risks over minor optimizations.
1. **Financial Integrity (Concurrency & Atomicity):** I prioritized fixing negative balances (atomic withdrawals), preventing duplicate ledger credits (consumer idempotency), and stopping duplicate debits on timeout (API idempotency). Financial loss is the highest severity risk for a wallet platform like this.
2. **Reliability (The Outbox Pattern & DLQ):** I implemented the Transactional Outbox pattern to eliminate the dual-write problem, and set up a DLQ so failed messages are never silently dropped.
3. **Availability & Stability (Memory Leaks & N+1):** I prioritized fixing the EventEmitter memory leak because it causes hard application crashes (OOM). I then fixed the N+1 query and missing database indexes because they cause unbounded CPU/DB spikes as traffic grows.
4. **Consistency (Cache Invalidation):** I fixed the Redis caching gap so users aren't confused by stale balances immediately after transactions.
5. **Observability (Correlation IDs):** Tracking requests in a distributed system is critical for on-call engineers, so I prioritized wiring up `AsyncLocalStorage`.

## 3. How did you handle concurrency?

- **Wallet Withdrawals:** Replaced the vulnerable read-modify-write pattern with an atomic MongoDB update: `{ $inc: { balance: -amount } }` alongside a query filter `{ balance: { $gte: amount } }`. This pushes the lock constraint to the database level, guaranteeing no negative balances under any interleaving. Verified by fixing the test suite.
- **API Idempotency:** Implemented a Fast-Check logic layer alongside a hard-lock database constraint (`{ unique: true }` on `idempotencyKey` in the `Transfer` schema). This handles Time Of Check to Time Of Use race conditions perfectly.
- **Optimistic Locking:** Retained the `version` increment architecture (`$inc: { version: 1 }`) on wallets to easily detect conflicts for future multi-document updates.

## 4. How did you ensure data consistency?

- **MongoDB vs RabbitMQ:** I eliminated the dual-write problem by introducing the **Transactional Outbox Pattern**. The `transfer` process now writes an OutboxEvent document in the *same MongoDB transaction* as the balance deduction. A background worker (or CDC pipeline) then safely publishes the OutboxEvent to RabbitMQ.
- **Message Queues:** Applied the **Inbox Pattern / Consumer Idempotency** in the `TransferEventsConsumer` by ensuring we check if a transfer's status is already `COMPLETED` before processing a `TransferInitiatedEvent`.
- **Redis Cache:** Integrated cache invalidation (`del(walletId)`) securely alongside state-mutating actions (deposit, withdraw, transfer).

## 5. Trade-offs

- **Outbox Polling vs CDC:** I implemented a simple interval-based background worker to poll the Outbox collection and publish messages to RabbitMQ. The trade-off is slightly higher latency (up to 2 seconds) compared to a true CDC (Change Data Capture) tool like Debezium. I chose this because it is much simpler to implement and deploy within the existing NestJS architecture without adding external infrastructure.
- **Cache Invalidation vs Mutation:** Instead of updating the Redis cache with the exact new balance (which can race), I chose to simply `del` the cache key. The next read request will fetch the guaranteed source-of-truth from MongoDB. This trades a minor read latency hit for absolute cache safety.

## 6. Remaining technical debt

- **Outbox Worker Scalability:** The current outbox worker runs on a `setInterval`. If the service is horizontally scaled to multiple pods, they will race to poll the same outbox events. This needs a distributed lock (e.g., Redis Redlock) or MongoDB `$findAndModify` concurrency controls.
- **Message Poisoning:** While we created a DLQ, there is currently no administrative API or retry script built to inspect and replay messages from the DLQ.

## 7. What would you improve with another day?

- Implement a true Inbox Pattern schema for the consumer to deduplicate messages based on a strict unique `eventId` index rather than just checking the transfer status.
- Add comprehensive Prometheus metrics (e.g., transfer success rate, DLQ depth, outbox lag) to monitor the health of the asynchronous pipeline.
- Implement a distributed lock (Redis) for the Outbox processor to safely support horizontal scaling of the API servers.

## 8. Assumptions

- **Traffic Patterns:** Assumed the system is read-heavy (hence the necessity of Redis for the dashboard) but prone to sudden spikes in concurrent writes (hence atomic queries over read-modify-write).
- **Scale:** Assumed the application runs in a container orchestration environment like Kubernetes where memory leaks (Task 6) would trigger constant OOM restarts, heavily degrading user experience.
- **DLQ Topology:** Assumed standard AMQP topology is acceptable (using a `.dlx` Topic exchange routing to a `.dlq` queue). 
