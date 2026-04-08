CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`dm_message_id` text,
	`uploader_id` text,
	`filename` text NOT NULL,
	`original_name` text NOT NULL,
	`mimetype` text NOT NULL,
	`size` integer NOT NULL,
	`thumbnail_filename` text,
	`width` integer,
	`height` integer,
	`duration` real,
	`source_url` text,
	`federation_status` text,
	`federation_meta` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dm_message_id`) REFERENCES `dm_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bans` (
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`reason` text,
	`banned_by` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `user_id`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`banned_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `category_overrides` (
	`category_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`allow` text DEFAULT '0' NOT NULL,
	`deny` text DEFAULT '0' NOT NULL,
	PRIMARY KEY(`category_id`, `target_type`, `target_id`),
	FOREIGN KEY (`category_id`) REFERENCES `channel_categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `channel_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `channel_overrides` (
	`channel_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`allow` text DEFAULT '0' NOT NULL,
	`deny` text DEFAULT '0' NOT NULL,
	PRIMARY KEY(`channel_id`, `target_type`, `target_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`topic` text,
	`position` integer DEFAULT 0,
	`category_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `dm_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`federated_id` text,
	`owner_home_user_id` text,
	`owner_home_instance` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dm_members` (
	`dm_channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`closed` integer DEFAULT 0,
	PRIMARY KEY(`dm_channel_id`, `user_id`),
	FOREIGN KEY (`dm_channel_id`) REFERENCES `dm_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `dm_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`dm_channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`reply_to_id` text,
	`content` text,
	`type` text DEFAULT 'user' NOT NULL,
	`edited_at` integer,
	`source_instance` text,
	`source_message_id` text,
	`encryption_version` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`dm_channel_id`) REFERENCES `dm_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_to_id`) REFERENCES `dm_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `dm_reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`dm_message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`dm_message_id`) REFERENCES `dm_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `embeds` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`dm_message_id` text,
	`url` text NOT NULL,
	`embed_type` text NOT NULL,
	`provider` text,
	`title` text,
	`description` text,
	`image` text,
	`embed_url` text,
	`width` integer,
	`height` integer,
	`color` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dm_message_id`) REFERENCES `dm_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `federation_file_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`peer_origin` text NOT NULL,
	`dm_message_id` text NOT NULL,
	`source_url` text NOT NULL,
	`target_filename` text,
	`original_name` text NOT NULL,
	`mimetype` text NOT NULL,
	`size` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`rejection_reason` text,
	`attempts` integer DEFAULT 0,
	`next_retry_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `federation_mutation_log` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`context_id` text NOT NULL,
	`context_type` text DEFAULT 'dm' NOT NULL,
	`mutation_type` text NOT NULL,
	`mutated_at` integer NOT NULL,
	`payload` text
);
--> statement-breakpoint
CREATE TABLE `federation_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`peer_id` text NOT NULL,
	`context_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`context_type` text DEFAULT 'dm' NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`encryption_version` integer DEFAULT 0,
	`attempts` integer DEFAULT 0,
	`next_retry_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`peer_id`) REFERENCES `federation_peers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `federation_peers` (
	`id` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`instance_name` text,
	`hmac_secret` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_seen_at` integer,
	`last_failure_at` integer,
	`consecutive_failures` integer DEFAULT 0,
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
CREATE TABLE `friend_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`status` text DEFAULT 'pending',
	`created_at` integer NOT NULL,
	FOREIGN KEY (`from_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `friends` (
	`user_id` text NOT NULL,
	`friend_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `friend_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`friend_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `instance_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`instance_name` text DEFAULT 'Backspace',
	`worker_id` integer,
	`discovery_enabled` integer DEFAULT 1 NOT NULL,
	`max_bitrate_kbps` integer DEFAULT 20000 NOT NULL,
	`min_bitrate_kbps` integer DEFAULT 500 NOT NULL,
	`bitrate_step_kbps` integer DEFAULT 500 NOT NULL,
	`allowed_resolutions` text DEFAULT '540,720,1080' NOT NULL,
	`allowed_framerates` text DEFAULT '30,45,60' NOT NULL,
	`max_resolution` integer DEFAULT 1080 NOT NULL,
	`max_framerate` integer DEFAULT 60 NOT NULL,
	`registration_open` integer,
	`gif_api_key` text,
	`bitrate_matrix_overrides` text,
	`allow_custom_bitrate` integer DEFAULT 1 NOT NULL,
	`max_upload_size_bytes` integer,
	`federation_relay_enabled` integer DEFAULT 1 NOT NULL,
	`federation_relay_ttl_days` integer DEFAULT 30 NOT NULL,
	`default_auto_rotate_interval_days` integer DEFAULT 90 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `join_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`message` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `member_roles` (
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	PRIMARY KEY(`space_id`, `user_id`, `role_id`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`reply_to_id` text,
	`content` text,
	`edited_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_to_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `read_states` (
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`last_read_message_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `channel_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#b9bbbe',
	`position` integer DEFAULT 0,
	`permissions` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `space_folder_members` (
	`folder_id` text NOT NULL,
	`space_id` text NOT NULL,
	`position` integer DEFAULT 0,
	PRIMARY KEY(`folder_id`, `space_id`),
	FOREIGN KEY (`folder_id`) REFERENCES `space_folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `space_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text,
	`color` text,
	`position` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `space_members` (
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`nickname` text,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `user_id`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`banner` text,
	`avatar_color` text,
	`owner_id` text NOT NULL,
	`invite_code` text,
	`visibility` text DEFAULT 'private',
	`description` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `user_federation_registry` (
	`user_id` text NOT NULL,
	`origin` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`username` text DEFAULT '' NOT NULL,
	`remote_user_id` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'connected' NOT NULL,
	`added_at` integer NOT NULL,
	`last_connected_at` integer,
	`disconnected_at` integer,
	`error_message` text,
	PRIMARY KEY(`user_id`, `origin`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_space_layout` (
	`user_id` text PRIMARY KEY NOT NULL,
	`layout` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text,
	`password_hash` text NOT NULL,
	`avatar` text,
	`status` text DEFAULT 'offline',
	`custom_status` text,
	`is_admin` integer DEFAULT 0,
	`home_instance` text,
	`home_user_id` text,
	`replicated_instances` text DEFAULT '[]',
	`banner` text,
	`accent_color` text,
	`avatar_color` text,
	`bio` text,
	`is_deleted` integer DEFAULT 0,
	`discoverable` integer DEFAULT 1,
	`profile_updated_at` integer,
	`password_changed_at` integer,
	`show_activity` integer DEFAULT 1 NOT NULL,
	`federation_registry_updated_at` integer DEFAULT 0,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `voice_restrictions` (
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`restriction_type` text NOT NULL,
	`moderator_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `user_id`, `restriction_type`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`moderator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_attachments_message_id` ON `attachments` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_attachments_dm_message_id` ON `attachments` (`dm_message_id`);--> statement-breakpoint
CREATE INDEX `idx_bans_space_id` ON `bans` (`space_id`);--> statement-breakpoint
CREATE INDEX `idx_category_overrides_category_id` ON `category_overrides` (`category_id`);--> statement-breakpoint
CREATE INDEX `idx_channel_categories_space_id` ON `channel_categories` (`space_id`);--> statement-breakpoint
CREATE INDEX `idx_channel_overrides_channel_id` ON `channel_overrides` (`channel_id`);--> statement-breakpoint
CREATE INDEX `idx_channels_space_id` ON `channels` (`space_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_dm_federated` ON `dm_channels` (`federated_id`) WHERE federated_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_dm_members_user_id` ON `dm_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_dm_messages_dm_channel_id` ON `dm_messages` (`dm_channel_id`);--> statement-breakpoint
CREATE INDEX `idx_dm_messages_user_id` ON `dm_messages` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_dm_messages_source_unique` ON `dm_messages` (`source_instance`,`source_message_id`) WHERE source_instance IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_dm_reactions_dm_message_id` ON `dm_reactions` (`dm_message_id`);--> statement-breakpoint
CREATE INDEX `idx_embeds_message_id` ON `embeds` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_embeds_dm_message_id` ON `embeds` (`dm_message_id`);--> statement-breakpoint
CREATE INDEX `idx_mutation_log_time` ON `federation_mutation_log` (`mutated_at`);--> statement-breakpoint
CREATE INDEX `idx_outbox_retry` ON `federation_outbox` (`next_retry_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `federation_outbox_peer_id_entity_id_unique` ON `federation_outbox` (`peer_id`,`entity_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `federation_peers_origin_unique` ON `federation_peers` (`origin`);--> statement-breakpoint
CREATE INDEX `idx_friend_requests_to_id` ON `friend_requests` (`to_id`);--> statement-breakpoint
CREATE INDEX `idx_friend_requests_from_id` ON `friend_requests` (`from_id`);--> statement-breakpoint
CREATE INDEX `idx_friends_user_id` ON `friends` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_friends_friend_id` ON `friends` (`friend_id`);--> statement-breakpoint
CREATE INDEX `idx_join_requests_space_id_status` ON `join_requests` (`space_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_member_roles_user_id_space_id` ON `member_roles` (`user_id`,`space_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_channel_id` ON `messages` (`channel_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_user_id` ON `messages` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_reactions_message_id` ON `reactions` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_read_states_user_id` ON `read_states` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_roles_space_id` ON `roles` (`space_id`);--> statement-breakpoint
CREATE INDEX `idx_space_members_user_id` ON `space_members` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `spaces_invite_code_unique` ON `spaces` (`invite_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE INDEX `idx_voice_restrictions_space_id` ON `voice_restrictions` (`space_id`);