ALTER TABLE `users` ADD `chosen_status` text DEFAULT 'online' NOT NULL;--> statement-breakpoint
-- Hand-written backfill: keep the choice of every account that owns its status
-- and is idle or dnd at upgrade time. Migrations run before the boot presence
-- reset, so the live `status` column still holds that choice here; after the
-- reset it is 'offline' and the choice would be lost. "Owns its status" is
-- `ownsChosenStatus` in packages/shared/src/types.ts: a native row
-- (`home_instance IS NULL`) or a detached one (`federation_home_orphaned = 1`).
-- Replicated rows are left at the default: their chosen_status is never read.
UPDATE `users` SET `chosen_status` = `status` WHERE (`home_instance` IS NULL OR `federation_home_orphaned` = 1) AND `status` IN ('idle', 'dnd');
