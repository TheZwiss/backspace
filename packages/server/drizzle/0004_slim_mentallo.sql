CREATE TABLE `invite_links` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`name` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`max_uses` integer,
	`used_count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `invite_redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`invite_id` text NOT NULL,
	`user_id` text,
	`registrant_username` text NOT NULL,
	`redeemed_at` integer NOT NULL,
	FOREIGN KEY (`invite_id`) REFERENCES `invite_links`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `federated_registration_open` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `invite_links_token_unique` ON `invite_links` (`token`);--> statement-breakpoint
CREATE INDEX `idx_invite_links_created_at` ON `invite_links` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_invite_redemptions_invite_id` ON `invite_redemptions` (`invite_id`);--> statement-breakpoint
CREATE INDEX `idx_invite_redemptions_user_id` ON `invite_redemptions` (`user_id`);