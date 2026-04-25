ALTER TABLE `friend_requests` ADD `relay_message_id` text;--> statement-breakpoint
CREATE INDEX `idx_friend_requests_relay_message_id` ON `friend_requests` (`relay_message_id`);