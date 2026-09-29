DROP INDEX `federation_outbox_peer_id_entity_id_unique`;--> statement-breakpoint
ALTER TABLE `federation_outbox` ADD `queue_key` text;--> statement-breakpoint
ALTER TABLE `federation_outbox` ADD `offered_at` integer;--> statement-breakpoint
CREATE INDEX `idx_outbox_queue` ON `federation_outbox` (`peer_id`,`queue_key`,`created_at`);--> statement-breakpoint
-- Hand-written backfill, part 1: whether a queued row already reached its peer
-- was never recorded. A row the peer may hold must not be cancelled or folded
-- as if it never left (federationOutboxQueue.ts), so every row queued before
-- this migration counts as offered. The cost is at most one extra event.
UPDATE `federation_outbox` SET `offered_at` = `created_at`;--> statement-breakpoint
-- Hand-written backfill, part 2: untargeted broadcasts used to be queued onto
-- pending peers too (#321). Presence on an auto-created pending peer is always
-- redundant, since every activation pushes a fresh presence snapshot, and it
-- is what kept such rows from being swept. queue_key is filled at boot by
-- backfillOutboxQueueKeys, from the same rule the queue uses.
DELETE FROM `federation_outbox` WHERE `event_type` = 'presence_update' AND `peer_id` IN (SELECT `id` FROM `federation_peers` WHERE `status` = 'pending' AND `initiated_by` = 'auto');
