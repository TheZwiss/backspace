CREATE TABLE `user_recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_totp` (
	`user_id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`algorithm` text DEFAULT 'SHA1' NOT NULL,
	`digits` integer DEFAULT 6 NOT NULL,
	`period` integer DEFAULT 30 NOT NULL,
	`verified_at` integer,
	`last_used_counter` text DEFAULT '0' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_recovery_codes_user_id` ON `user_recovery_codes` (`user_id`);