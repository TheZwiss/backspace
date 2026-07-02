CREATE TABLE `federation_attach_proofs` (
	`token` text PRIMARY KEY NOT NULL,
	`home_user_id` text NOT NULL,
	`target_domain` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
