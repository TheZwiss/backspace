CREATE TABLE `bot_token_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`token_id` text NOT NULL,
	`bot_user_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`action` text NOT NULL,
	`details` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bot_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`allowed_channels` text,
	`label` text,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	`revoked_reason` text,
	FOREIGN KEY (`bot_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `users` ADD `account_type` text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `owner_user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `users` ADD `bot_display_tag` text;--> statement-breakpoint
CREATE INDEX `idx_bot_token_audit_token_id` ON `bot_token_audit` (`token_id`);--> statement-breakpoint
CREATE INDEX `idx_bot_token_audit_bot_user_id` ON `bot_token_audit` (`bot_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bot_tokens_token_hash_unique` ON `bot_tokens` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_bot_tokens_hash` ON `bot_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_bot_tokens_bot_user_id` ON `bot_tokens` (`bot_user_id`);--> statement-breakpoint
/*
 SQLite does not support "Creating foreign key on existing column" out of the box, we do not generate automatic migration for that, so it has to be done manually
 Please refer to: https://www.techonthenet.com/sqlite/tables/alter_table.php
                  https://www.sqlite.org/lang_altertable.html

 Due to that we don't generate migration automatically and it has to be done manually
*/