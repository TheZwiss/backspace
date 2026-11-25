CREATE TABLE `ai_translation_provider` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`provider_label` text NOT NULL,
	`protocol` text NOT NULL,
	`base_url` text NOT NULL,
	`model` text NOT NULL,
	`encrypted_api_key` blob NOT NULL,
	`updated_at` integer NOT NULL,
	CHECK (`id` = 1)
);
--> statement-breakpoint
CREATE TABLE `ai_translation_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`consented_provider_fingerprint` text,
	`consented_at` integer,
	`target_language` text DEFAULT 'en' NOT NULL,
	`show_original` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ai_translation_cache` (
	`instance_id` text NOT NULL,
	`user_id` text NOT NULL,
	`result_key` text NOT NULL,
	`encrypted` blob NOT NULL,
	`used_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `result_key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ai_translation_cache_lru` ON `ai_translation_cache` (`user_id`, `used_at`);
--> statement-breakpoint
CREATE TRIGGER `purge_deleted_user_translation` AFTER UPDATE OF `is_deleted` ON `users`
WHEN NEW.`is_deleted` = 1
BEGIN
	DELETE FROM `ai_translation_preferences` WHERE `user_id` = NEW.`id`;
	DELETE FROM `ai_translation_cache` WHERE `user_id` = NEW.`id`;
END;
