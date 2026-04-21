PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint
CREATE TABLE `__new_federation_peers` (
	`id` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`instance_name` text,
	`hmac_secret` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_seen_at` integer,
	`last_failure_at` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`consecutive_auth_failures` integer DEFAULT 0 NOT NULL,
	`last_synced_at` integer DEFAULT 0,
	`remote_max_upload_size` integer,
	`nonce_supported` integer DEFAULT 0 NOT NULL,
	`pending_hmac_secret` text,
	`secret_rotation_at` integer,
	`secret_rotated_at` integer,
	`auto_rotate_interval_days` integer DEFAULT 90 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_federation_peers`("id", "origin", "instance_name", "hmac_secret", "status", "last_seen_at", "last_failure_at", "consecutive_failures", "consecutive_auth_failures", "last_synced_at", "remote_max_upload_size", "nonce_supported", "pending_hmac_secret", "secret_rotation_at", "secret_rotated_at", "auto_rotate_interval_days", "created_at") SELECT "id", "origin", "instance_name", "hmac_secret", "status", "last_seen_at", "last_failure_at", COALESCE("consecutive_failures", 0), "consecutive_auth_failures", "last_synced_at", "remote_max_upload_size", "nonce_supported", "pending_hmac_secret", "secret_rotation_at", "secret_rotated_at", "auto_rotate_interval_days", "created_at" FROM `federation_peers`;
--> statement-breakpoint
DROP TABLE `federation_peers`;
--> statement-breakpoint
ALTER TABLE `__new_federation_peers` RENAME TO `federation_peers`;
--> statement-breakpoint
CREATE UNIQUE INDEX `federation_peers_origin_unique` ON `federation_peers` (`origin`);
