CREATE TABLE `bot_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`name` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`bot_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_bot_tokens_bot_id` ON `bot_tokens` (`bot_id`);
