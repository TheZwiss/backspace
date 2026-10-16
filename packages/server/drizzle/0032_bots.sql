CREATE TABLE `bot_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_bot_commands_bot_name` ON `bot_commands` (`bot_id`,`name`);--> statement-breakpoint
CREATE TABLE `interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`user_id` text NOT NULL,
	`channel_id` text,
	`dm_channel_id` text,
	`command` text NOT NULL,
	`options` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`responses` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_interactions_expires_at` ON `interactions` (`expires_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `is_bot` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `bot_owner_id` text;--> statement-breakpoint
CREATE INDEX `idx_users_bot_owner_id` ON `users` (`bot_owner_id`);