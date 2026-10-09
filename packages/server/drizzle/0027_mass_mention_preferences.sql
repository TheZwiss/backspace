ALTER TABLE `notification_settings` ADD `suppress_everyone` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `notification_settings` ADD `suppress_roles` integer DEFAULT 0 NOT NULL;
