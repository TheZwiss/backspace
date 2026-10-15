CREATE TABLE `sticker_packs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`creator_id` text,
	`creator_name` text,
	`cover_asset_id` text,
	`origin_type` text DEFAULT 'source' NOT NULL,
	`source_instance` text,
	`source_pack_id` text,
	`current_version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`review_notes` text,
	`reviewed_by` text,
	`reviewed_at` integer,
	`synced_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`cover_asset_id`) REFERENCES `sticker_assets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_sticker_packs_status` ON `sticker_packs` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_sticker_packs_creator` ON `sticker_packs` (`creator_id`);
--> statement-breakpoint
CREATE INDEX `idx_sticker_packs_source` ON `sticker_packs` (`source_instance`, `source_pack_id`);
--> statement-breakpoint
CREATE TABLE `sticker_pack_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`pack_id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`cover_asset_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`review_notes` text,
	`reviewed_by` text,
	`reviewed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`pack_id`) REFERENCES `sticker_packs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cover_asset_id`) REFERENCES `sticker_assets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pack_versions_unique` ON `sticker_pack_versions` (`pack_id`, `version`);
--> statement-breakpoint
CREATE TABLE `sticker_pack_items` (
	`id` text PRIMARY KEY NOT NULL,
	`pack_id` text NOT NULL,
	`version_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`pack_id`) REFERENCES `sticker_packs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`version_id`) REFERENCES `sticker_pack_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `sticker_assets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_sticker_pack_items_pack` ON `sticker_pack_items` (`pack_id`);
--> statement-breakpoint
CREATE INDEX `idx_sticker_pack_items_version` ON `sticker_pack_items` (`version_id`);
--> statement-breakpoint
CREATE INDEX `idx_sticker_pack_items_asset` ON `sticker_pack_items` (`asset_id`);
--> statement-breakpoint
CREATE TABLE `user_installed_packs` (
	`user_id` text NOT NULL,
	`pack_id` text NOT NULL,
	`installed_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `pack_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pack_id`) REFERENCES `sticker_packs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_installed_packs_user` ON `user_installed_packs` (`user_id`);
--> statement-breakpoint
CREATE TABLE `sticker_peer_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`peer_origin` text NOT NULL,
	`policy` text DEFAULT 'allow' NOT NULL,
	`auto_sync` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sticker_peer_policies_peer_origin_unique` ON `sticker_peer_policies` (`peer_origin`);
--> statement-breakpoint
CREATE INDEX `idx_sticker_peer_policies_peer` ON `sticker_peer_policies` (`peer_origin`);
