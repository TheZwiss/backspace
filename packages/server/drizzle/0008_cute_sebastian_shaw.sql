CREATE TABLE `federation_reset_events` (
	`origin` text PRIMARY KEY NOT NULL,
	`dead_epoch` text NOT NULL,
	`new_epoch` text,
	`detected_at` integer NOT NULL,
	`resolved_at` integer,
	`stub_count` integer DEFAULT 0 NOT NULL,
	`orphaned_account_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `federation_peers` ADD `peer_instance_id` text;--> statement-breakpoint
ALTER TABLE `federation_peers` ADD `observed_peer_instance_id` text;--> statement-breakpoint
ALTER TABLE `federation_peers` ADD `needs_attention_reason` text;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `instance_id` text;--> statement-breakpoint
ALTER TABLE `users` ADD `federation_heal_pending` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `federation_home_orphaned` integer DEFAULT 0;