-- federation_outbox is rebuilt rather than altered, because its
-- (peer_id, entity_id) uniqueness has two shapes in the field. Installs from
-- the squashed migration history carry it as the named index
-- federation_outbox_peer_id_entity_id_unique. Databases created before the
-- squash carry it as an inline UNIQUE(peer_id, entity_id) table constraint,
-- an sqlite_autoindex that no DROP INDEX can remove. Dropping the old table
-- removes either form along with idx_outbox_retry, so both shapes end here.
--
-- The migrator runs every pending migration inside one transaction on a
-- connection with foreign_keys = ON, where PRAGMA foreign_keys is a no-op, so
-- this file sets no pragma and relies on enforcement staying on: no table
-- references federation_outbox, so dropping it cascades nowhere, and the copy
-- below is checked against federation_peers row by row.
CREATE TABLE `__new_federation_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`peer_id` text NOT NULL,
	`context_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`queue_key` text,
	`context_type` text DEFAULT 'dm' NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`encryption_version` integer DEFAULT 0,
	`attempts` integer DEFAULT 0,
	`next_retry_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`offered_at` integer,
	FOREIGN KEY (`peer_id`) REFERENCES `federation_peers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Hand-written backfill, part 1: whether a queued row already reached its peer
-- was never recorded. A row the peer may hold must not be cancelled or folded
-- as if it never left (federationOutboxQueue.ts), so every row queued before
-- this migration counts as offered: offered_at is copied from created_at. The
-- cost is at most one extra event. queue_key is filled at boot by
-- backfillOutboxQueueKeys, from the same rule the queue uses.
--
-- A row whose peer no longer exists (left behind by a peer deleted while
-- foreign keys were not enforced) could never be delivered and would fail the
-- foreign key check on insert, aborting the migration, so it is not copied.
INSERT INTO `__new_federation_outbox` (`id`, `peer_id`, `context_id`, `entity_id`, `queue_key`, `context_type`, `event_type`, `payload`, `encryption_version`, `attempts`, `next_retry_at`, `expires_at`, `created_at`, `offered_at`)
SELECT `id`, `peer_id`, `context_id`, `entity_id`, NULL, `context_type`, `event_type`, `payload`, `encryption_version`, `attempts`, `next_retry_at`, `expires_at`, `created_at`, `created_at`
FROM `federation_outbox`
WHERE `peer_id` IN (SELECT `id` FROM `federation_peers`);--> statement-breakpoint
DROP TABLE `federation_outbox`;--> statement-breakpoint
ALTER TABLE `__new_federation_outbox` RENAME TO `federation_outbox`;--> statement-breakpoint
CREATE INDEX `idx_outbox_queue` ON `federation_outbox` (`peer_id`,`queue_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_outbox_retry` ON `federation_outbox` (`next_retry_at`);--> statement-breakpoint
-- Hand-written backfill, part 2: untargeted broadcasts used to be queued onto
-- pending peers too (#321). Presence on an auto-created pending peer is always
-- redundant, since every activation pushes a fresh presence snapshot, and it
-- is what kept such rows from being swept.
DELETE FROM `federation_outbox` WHERE `event_type` = 'presence_update' AND `peer_id` IN (SELECT `id` FROM `federation_peers` WHERE `status` = 'pending' AND `initiated_by` = 'auto');
