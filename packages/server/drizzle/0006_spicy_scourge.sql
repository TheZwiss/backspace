ALTER TABLE `federation_peers` ADD `last_probe_at` integer;--> statement-breakpoint
ALTER TABLE `federation_peers` ADD `probe_attempts` integer DEFAULT 0 NOT NULL;