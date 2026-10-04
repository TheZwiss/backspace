ALTER TABLE `users` ADD `is_bot` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `bot_owner_id` text;--> statement-breakpoint
CREATE INDEX `idx_users_bot_owner_id` ON `users` (`bot_owner_id`);