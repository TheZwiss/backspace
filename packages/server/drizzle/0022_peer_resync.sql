CREATE TABLE `federation_applied_events` (
	`source_origin` text NOT NULL,
	`event_key` text NOT NULL,
	`applied_at` integer NOT NULL,
	PRIMARY KEY(`source_origin`, `event_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_applied_events_applied_at` ON `federation_applied_events` (`applied_at`);--> statement-breakpoint
CREATE TABLE `federation_subject_clocks` (
	`subject_key` text PRIMARY KEY NOT NULL,
	`changed_at` integer NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_subject_clocks_recorded_at` ON `federation_subject_clocks` (`recorded_at`);--> statement-breakpoint
CREATE TABLE `federation_sync_cursors` (
	`peer_id` text NOT NULL,
	`context_type` text NOT NULL,
	`cursor_ts` integer DEFAULT 0 NOT NULL,
	`cursor_id` text,
	`peer_epoch` text,
	`last_pulled_at` integer,
	PRIMARY KEY(`peer_id`, `context_type`),
	FOREIGN KEY (`peer_id`) REFERENCES `federation_peers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `federation_sync_retry` (
	`id` text PRIMARY KEY NOT NULL,
	`peer_id` text NOT NULL,
	`context_type` text NOT NULL,
	`subject_key` text NOT NULL,
	`event_type` text NOT NULL,
	`message_id` text NOT NULL,
	`event_ts` integer NOT NULL,
	`event_hash` text NOT NULL,
	`event_json` text NOT NULL,
	`last_reason` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`first_failed_at` integer NOT NULL,
	`next_retry_at` integer NOT NULL,
	FOREIGN KEY (`peer_id`) REFERENCES `federation_peers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sync_retry_event` ON `federation_sync_retry` (`peer_id`,`event_hash`);--> statement-breakpoint
CREATE INDEX `idx_sync_retry_subject` ON `federation_sync_retry` (`peer_id`,`subject_key`);--> statement-breakpoint
CREATE INDEX `idx_sync_retry_order` ON `federation_sync_retry` (`peer_id`,`event_ts`);--> statement-breakpoint
ALTER TABLE `dm_members` ADD `closed_changed_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `ledger_started_at` integer;--> statement-breakpoint
-- Hand-written, not generated. Every existing member row takes the migration
-- time as the moment its `closed` state was set, so a dm_close or dm_reopen
-- from before the upgrade that a peer's mutation log replays is older than the
-- row's state and is ignored (last-writer-wins, utils/dmMemberClosed.ts).
UPDATE `dm_members` SET `closed_changed_at` = CAST(strftime('%s','now') AS INTEGER) * 1000;
--> statement-breakpoint
-- Hand-written, not generated. The time this instance began recording applied
-- relay events. An existing instance has a settings row; a first boot does
-- not yet, and keeps null: it recorded every event it applied.
UPDATE `instance_settings` SET `ledger_started_at` = CAST(strftime('%s','now') AS INTEGER) * 1000;
--> statement-breakpoint
-- Hand-written, not generated. A peer that has synced before was pulled up to
-- `last_synced_at` by the pull this release replaces, which asked for rows
-- after that time. Every context's cursor starts there, as that pull's next
-- run would have, instead of at 0, which would replay the peer's whole log.
INSERT INTO `federation_sync_cursors` (`peer_id`, `context_type`, `cursor_ts`, `cursor_id`, `peer_epoch`, `last_pulled_at`)
SELECT `p`.`id`, `c`.`context_type`, `p`.`last_synced_at`, NULL, `p`.`peer_instance_id`, NULL
FROM `federation_peers` AS `p`
CROSS JOIN (SELECT 'dm' AS `context_type` UNION ALL SELECT 'friend' UNION ALL SELECT 'profile') AS `c`
WHERE `p`.`last_synced_at` > 0;
