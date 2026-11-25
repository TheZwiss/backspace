CREATE TABLE `bot_revocations` (
	`bot_id` text NOT NULL,
	`origin` text NOT NULL,
	`mode` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`next_attempt_at` integer NOT NULL,
	PRIMARY KEY(`bot_id`, `origin`)
);
--> statement-breakpoint
CREATE INDEX `idx_bot_revocations_next_attempt_at` ON `bot_revocations` (`next_attempt_at`);
