CREATE TABLE `bot_seat_restrictions` (
	`channel_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`restriction_type` text NOT NULL,
	`moderator_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`channel_id`, `bot_id`, `restriction_type`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bot_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`moderator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_bot_seat_restrictions_bot_id` ON `bot_seat_restrictions` (`bot_id`);