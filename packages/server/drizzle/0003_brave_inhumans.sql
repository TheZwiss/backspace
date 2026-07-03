CREATE TABLE `peer_approval_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`peer_origin` text NOT NULL,
	`trigger_reason` text NOT NULL,
	`trigger_target` text NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `peer_approval_subscribers` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`user_id` text NOT NULL,
	`trigger_reason` text NOT NULL,
	`trigger_target` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `peer_approval_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_peer_approval_notifications_user_id` ON `peer_approval_notifications` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_peer_approval_subscribers_user_id` ON `peer_approval_subscribers` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `peer_approval_subscribers_request_id_user_id_trigger_reason_trigger_target_unique` ON `peer_approval_subscribers` (`request_id`,`user_id`,`trigger_reason`,`trigger_target`);--> statement-breakpoint
-- Recreate peer_approval_requests:
--   - add direction column (default 'inbound') so existing rows classify correctly
--   - relax hmac_secret to nullable (outbound rows generate fresh on approval)
--   - drop UNIQUE(origin); add UNIQUE(origin, direction)
--   - add CHECK enforcing inbound rows always carry hmac_secret
CREATE TABLE `__new_peer_approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`direction` text DEFAULT 'inbound' NOT NULL,
	`instance_name` text,
	`hmac_secret` text,
	`requested_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`approval_token` text,
	CHECK (
		(direction = 'inbound' AND hmac_secret IS NOT NULL)
		OR (direction = 'outbound')
	)
);--> statement-breakpoint
INSERT INTO `__new_peer_approval_requests` (`id`, `origin`, `direction`, `instance_name`, `hmac_secret`, `requested_at`, `expires_at`, `approval_token`)
SELECT `id`, `origin`, 'inbound', `instance_name`, `hmac_secret`, `requested_at`, `expires_at`, `approval_token` FROM `peer_approval_requests`;--> statement-breakpoint
DROP TABLE `peer_approval_requests`;--> statement-breakpoint
ALTER TABLE `__new_peer_approval_requests` RENAME TO `peer_approval_requests`;--> statement-breakpoint
CREATE UNIQUE INDEX `peer_approval_requests_origin_direction_unique` ON `peer_approval_requests` (`origin`,`direction`);
