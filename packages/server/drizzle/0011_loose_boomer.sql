CREATE TABLE `user_federation_credentials` (
	`user_id` text NOT NULL,
	`origin` text NOT NULL,
	`secret` text NOT NULL,
	`created_at` integer NOT NULL,
	`provisioned_at` integer,
	PRIMARY KEY(`user_id`, `origin`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
