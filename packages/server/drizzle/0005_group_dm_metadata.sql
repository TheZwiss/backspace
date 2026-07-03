ALTER TABLE `dm_channels` ADD `name` text;--> statement-breakpoint
ALTER TABLE `dm_channels` ADD `icon` text;--> statement-breakpoint
ALTER TABLE `dm_channels` ADD `metadata_updated_at` integer DEFAULT 0 NOT NULL;