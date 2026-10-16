ALTER TABLE `roles` ADD `managed_bot_id` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `bot_requested_permissions` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_roles_managed_bot` ON `roles` (`space_id`,`managed_bot_id`);
