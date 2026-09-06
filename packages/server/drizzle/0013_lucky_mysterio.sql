ALTER TABLE `instance_settings` ADD `telemetry_enabled` integer;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `telemetry_id` text;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `telemetry_last_day` text;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `telemetry_last_error` text;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `installed_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `last_active_day` text;--> statement-breakpoint
ALTER TABLE `users` ADD `last_client` text;