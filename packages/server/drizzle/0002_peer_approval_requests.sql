CREATE TABLE `peer_approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`instance_name` text,
	`hmac_secret` text NOT NULL,
	`requested_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `peer_approval_requests_origin_unique` ON `peer_approval_requests` (`origin`);
