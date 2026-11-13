CREATE TABLE `sticker_favorites` (
	`user_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `asset_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `sticker_assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sticker_pack_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`pack_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`requested_by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewed_by` text,
	`review_notes` text,
	`created_at` integer NOT NULL,
	`reviewed_at` integer,
	FOREIGN KEY (`pack_id`) REFERENCES `sticker_packs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sticker_share_target` ON `sticker_pack_shares` (`pack_id`,`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_sticker_share_target_status` ON `sticker_pack_shares` (`target_type`,`target_id`,`status`);--> statement-breakpoint
ALTER TABLE `sticker_packs` ADD `scope_type` text DEFAULT 'instance' NOT NULL;--> statement-breakpoint
ALTER TABLE `sticker_packs` ADD `space_id` text REFERENCES spaces(id);--> statement-breakpoint
CREATE INDEX `idx_sticker_packs_scope` ON `sticker_packs` (`scope_type`,`space_id`,`creator_id`);