ALTER TABLE `instance_settings` ADD `directory_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `directory_dirty` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `directory_last_ping_at` integer;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `directory_last_error` text;--> statement-breakpoint
ALTER TABLE `spaces` ADD `directory_listed` integer DEFAULT 0 NOT NULL;