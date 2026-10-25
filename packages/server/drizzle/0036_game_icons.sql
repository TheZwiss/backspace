CREATE TABLE `game_icon_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `game_icons` (
	`user_id` text NOT NULL,
	`icon_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `icon_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`icon_id`) REFERENCES `game_icon_assets`(`id`) ON UPDATE no action ON DELETE no action
);
