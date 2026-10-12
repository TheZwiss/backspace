CREATE TABLE `soundboard_settings` (
	`space_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`allow_member_uploads` integer DEFAULT true NOT NULL,
	`max_duration_seconds` real DEFAULT 10,
	`max_sounds` integer DEFAULT 50 NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `soundboard_sounds` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`uploader_id` text NOT NULL,
	`name` text NOT NULL,
	`emoji` text NOT NULL,
	`filename` text NOT NULL,
	`duration_seconds` real NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploader_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_soundboard_sounds_space_id` ON `soundboard_sounds` (`space_id`);
