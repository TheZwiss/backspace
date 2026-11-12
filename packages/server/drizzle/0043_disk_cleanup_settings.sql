ALTER TABLE `instance_settings` ADD `disk_cleanup_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `disk_cleanup_threshold_percent` integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `disk_cleanup_target_percent` integer DEFAULT 80 NOT NULL;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `disk_cleanup_min_age_days` integer DEFAULT 30 NOT NULL;