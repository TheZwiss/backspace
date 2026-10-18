CREATE TABLE `bookmark_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`bookmark_id` text NOT NULL,
	`position` integer NOT NULL,
	`original_name` text NOT NULL,
	`mimetype` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`duration` real,
	`playable` integer,
	`source_filename` text NOT NULL,
	`source_thumbnail_filename` text,
	`filename` text,
	`thumbnail_filename` text,
	`copy_status` text DEFAULT 'reference' NOT NULL,
	FOREIGN KEY (`bookmark_id`) REFERENCES `message_bookmarks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_bookmark_attachments_bookmark_id` ON `bookmark_attachments` (`bookmark_id`);--> statement-breakpoint
CREATE TABLE `message_bookmarks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`message_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`space_id` text,
	`content` text,
	`author_id` text NOT NULL,
	`author_name` text NOT NULL,
	`space_name` text,
	`channel_name` text,
	`instance_origin` text NOT NULL,
	`message_created_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_message_bookmarks_user_message` ON `message_bookmarks` (`user_id`,`kind`,`message_id`);--> statement-breakpoint
CREATE INDEX `idx_message_bookmarks_user_created` ON `message_bookmarks` (`user_id`,created_at DESC,id DESC);--> statement-breakpoint
CREATE INDEX `idx_message_bookmarks_user_channel` ON `message_bookmarks` (`user_id`,`kind`,`channel_id`);