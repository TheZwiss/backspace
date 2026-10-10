CREATE TABLE `personal_stickers` (
	`user_id` text NOT NULL,
	`sticker_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `sticker_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sticker_id`) REFERENCES `sticker_assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sticker_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
