-- Schema (DDL only, no data) of an instance created before the Drizzle
-- migration history was squashed into 0000_lethal_wildside. Its tables were
-- made by the hand-written statements of that time, so several differ from
-- what 0000-0020 create on a fresh install (inline UNIQUE constraints instead
-- of named indexes, text primary keys without NOT NULL, columns appended by
-- ALTER TABLE, leftover columns).
-- That instance has 0000-0020 recorded in __drizzle_migrations; the test that
-- loads this file records them the same way. Do not regenerate it from a
-- fresh install: the point is the old shape.
CREATE TABLE "__drizzle_migrations" (
      "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      "hash" text NOT NULL,
      "created_at" numeric
    );
CREATE TABLE "attachments" (
      id TEXT PRIMARY KEY,
      message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      dm_message_id TEXT REFERENCES dm_messages(id) ON DELETE CASCADE,
      uploader_id TEXT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      thumbnail_filename TEXT,
      width INTEGER,
      height INTEGER,
      duration REAL,
      created_at INTEGER NOT NULL
    , source_url TEXT, federation_status TEXT, federation_meta TEXT, `playable` integer);
CREATE TABLE "bans" (
          space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          reason TEXT,
          banned_by TEXT REFERENCES users(id),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (space_id, user_id)
        );
CREATE TABLE category_overrides (
        category_id TEXT NOT NULL REFERENCES channel_categories(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        allow TEXT NOT NULL DEFAULT '0',
        deny TEXT NOT NULL DEFAULT '0',
        PRIMARY KEY (category_id, target_type, target_id)
    );
CREATE TABLE channel_categories (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
CREATE TABLE channel_overrides (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      allow TEXT NOT NULL DEFAULT '0',
      deny TEXT NOT NULL DEFAULT '0',
      PRIMARY KEY (channel_id, target_type, target_id)
    );
CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      topic TEXT,
      position INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    , category_id TEXT);
CREATE TABLE "dm_channels" (
            id TEXT PRIMARY KEY,
            owner_id TEXT,
            federated_id TEXT,
            owner_home_user_id TEXT,
            owner_home_instance TEXT,
            deleted_at INTEGER,
            created_at INTEGER NOT NULL
          , `name` text, `icon` text, `metadata_updated_at` integer DEFAULT 0 NOT NULL);
CREATE TABLE dm_members (
      dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, closed INTEGER DEFAULT 0,
      PRIMARY KEY (dm_channel_id, user_id)
    );
CREATE TABLE "dm_messages" (id TEXT PRIMARY KEY, dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), reply_to_id TEXT REFERENCES "dm_messages"(id) ON DELETE SET NULL, content TEXT, edited_at INTEGER, created_at INTEGER NOT NULL, source_instance TEXT, source_message_id TEXT, encryption_version INTEGER DEFAULT 0, type TEXT NOT NULL DEFAULT 'user');
CREATE TABLE dm_reactions (
      id TEXT PRIMARY KEY,
      dm_message_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(dm_message_id, user_id, emoji)
    );
CREATE TABLE embeds (
      id TEXT PRIMARY KEY,
      message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      dm_message_id TEXT REFERENCES dm_messages(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      embed_type TEXT NOT NULL CHECK (embed_type IN ('generic', 'video', 'image', 'audio', 'rich')),
      provider TEXT,
      title TEXT,
      description TEXT,
      image TEXT,
      embed_url TEXT,
      width INTEGER,
      height INTEGER,
      color TEXT,
      created_at INTEGER NOT NULL,
      CHECK (
        (message_id IS NOT NULL AND dm_message_id IS NULL) OR
        (message_id IS NULL AND dm_message_id IS NOT NULL)
      )
    );
CREATE TABLE `federation_attach_proofs` (
	`token` text PRIMARY KEY NOT NULL,
	`home_user_id` text NOT NULL,
	`target_domain` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
CREATE TABLE federation_file_queue (
      id TEXT PRIMARY KEY,
      peer_origin TEXT NOT NULL,
      dm_message_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      target_filename TEXT,
      original_name TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      rejection_reason TEXT,
      attempts INTEGER DEFAULT 0,
      next_retry_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
CREATE TABLE "federation_mutation_log" (
            id TEXT PRIMARY KEY,
            entity_id TEXT NOT NULL,
            context_id TEXT NOT NULL,
            context_type TEXT NOT NULL DEFAULT 'dm',
            mutation_type TEXT NOT NULL,
            mutated_at INTEGER NOT NULL,
            payload TEXT
          );
CREATE TABLE "federation_outbox" (
            id TEXT PRIMARY KEY,
            peer_id TEXT NOT NULL REFERENCES federation_peers(id) ON DELETE CASCADE,
            context_id TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            context_type TEXT NOT NULL DEFAULT 'dm',
            event_type TEXT NOT NULL,
            payload TEXT NOT NULL,
            encryption_version INTEGER DEFAULT 0,
            attempts INTEGER DEFAULT 0,
            next_retry_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(peer_id, entity_id)
          );
CREATE TABLE "federation_peers" (
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
, `approval_token` text, `last_probe_at` integer, `probe_attempts` integer DEFAULT 0 NOT NULL, `peer_instance_id` text, `observed_peer_instance_id` text, `needs_attention_reason` text, `initiated_by` text DEFAULT 'auto' NOT NULL);
CREATE TABLE `federation_reset_events` (
	`origin` text PRIMARY KEY NOT NULL,
	`dead_epoch` text NOT NULL,
	`new_epoch` text,
	`detected_at` integer NOT NULL,
	`resolved_at` integer,
	`stub_count` integer DEFAULT 0 NOT NULL,
	`orphaned_account_count` integer DEFAULT 0 NOT NULL
, `acknowledged_at` integer);
CREATE TABLE friend_requests (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL
    , `relay_message_id` text);
CREATE TABLE friends (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, friend_id)
    );
CREATE TABLE instance_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      instance_name TEXT DEFAULT 'Backspace',
      worker_id INTEGER,
      max_bitrate_kbps INTEGER NOT NULL DEFAULT 20000,
      min_bitrate_kbps INTEGER NOT NULL DEFAULT 500,
      bitrate_step_kbps INTEGER NOT NULL DEFAULT 500,
      allowed_resolutions TEXT NOT NULL DEFAULT '540,720,1080',
      allowed_framerates TEXT NOT NULL DEFAULT '30,45,60',
      max_resolution INTEGER NOT NULL DEFAULT 1080,
      max_framerate INTEGER NOT NULL DEFAULT 60,
      updated_at INTEGER NOT NULL DEFAULT 0
    , discovery_enabled INTEGER NOT NULL DEFAULT 1, registration_open INTEGER, voice_bit_migrated INTEGER DEFAULT 0, thumbnails_backfilled INTEGER DEFAULT 0, tenor_api_key TEXT, gif_api_key TEXT, profile_attachments_cleaned INTEGER DEFAULT 0, media_dimensions_backfilled INTEGER DEFAULT 0, bitrate_matrix_overrides TEXT DEFAULT NULL, max_upload_size_bytes INTEGER, allow_custom_bitrate INTEGER NOT NULL DEFAULT 1, federation_relay_enabled INTEGER NOT NULL DEFAULT 0, federation_relay_ttl_days INTEGER NOT NULL DEFAULT 30, legacy_dm_sync_done INTEGER DEFAULT 0, default_auto_rotate_interval_days INTEGER NOT NULL DEFAULT 90, `auto_accept_peering` integer DEFAULT 1 NOT NULL, `federated_registration_open` integer DEFAULT 1 NOT NULL, `instance_id` text, `telemetry_enabled` integer, `telemetry_id` text, `telemetry_last_day` text, `telemetry_last_error` text, `installed_at` integer, `telemetry_declined_version` text, `directory_enabled` integer DEFAULT 0 NOT NULL, `directory_dirty` integer DEFAULT 0 NOT NULL, `directory_last_ping_at` integer, `directory_last_error` text, `directory_browse_enabled` integer DEFAULT 1 NOT NULL, `support_card_enabled` integer DEFAULT true NOT NULL);
CREATE TABLE `invite_links` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`name` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`max_uses` integer,
	`used_count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE TABLE `invite_redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`invite_id` text NOT NULL,
	`user_id` text,
	`registrant_username` text NOT NULL,
	`redeemed_at` integer NOT NULL,
	FOREIGN KEY (`invite_id`) REFERENCES `invite_links`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
CREATE TABLE join_requests (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT REFERENCES users(id),
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    );
CREATE TABLE member_roles (
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY (space_id, user_id, role_id)
    );
CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      reply_to_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      content TEXT,
      edited_at INTEGER,
      created_at INTEGER NOT NULL
    );
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
CREATE TABLE "peer_approval_requests" (
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
);
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
CREATE TABLE reactions (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(message_id, user_id, emoji)
    );
CREATE TABLE read_states (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      last_read_message_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, channel_id)
    );
CREATE TABLE roles (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#b9bbbe',
      position INTEGER DEFAULT 0,
      permissions TEXT,
      created_at INTEGER NOT NULL
    );
CREATE TABLE "space_folder_members" (
          folder_id TEXT NOT NULL REFERENCES space_folders(id) ON DELETE CASCADE,
          space_id TEXT NOT NULL,
          position INTEGER DEFAULT 0,
          PRIMARY KEY (folder_id, space_id)
        );
CREATE TABLE space_folders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT,
      color TEXT,
      position INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
CREATE TABLE space_members (
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nickname TEXT,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (space_id, user_id)
    );
CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      owner_id TEXT NOT NULL REFERENCES users(id),
      invite_code TEXT UNIQUE,
      created_at INTEGER NOT NULL
    , visibility TEXT DEFAULT 'private', description TEXT, banner TEXT, avatar_color TEXT, `directory_listed` integer DEFAULT 0 NOT NULL);
CREATE TABLE `user_federation_credentials` (
	`user_id` text NOT NULL,
	`origin` text NOT NULL,
	`secret` text NOT NULL,
	`created_at` integer NOT NULL,
	`provisioned_at` integer,
	PRIMARY KEY(`user_id`, `origin`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE user_federation_registry (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      origin TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      remote_user_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'connected',
      added_at INTEGER NOT NULL,
      last_connected_at INTEGER,
      disconnected_at INTEGER,
      error_message TEXT,
      PRIMARY KEY (user_id, origin)
    );
CREATE TABLE user_space_layout (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      layout TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      avatar TEXT,
      status TEXT DEFAULT 'offline',
      custom_status TEXT,
      home_instance TEXT,
      replicated_instances TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL
    , is_admin INTEGER DEFAULT 0, home_user_id TEXT, banner TEXT, accent_color TEXT, bio TEXT, avatar_color TEXT, is_deleted INTEGER DEFAULT 0, profile_updated_at INTEGER, discoverable INTEGER DEFAULT 1, password_changed_at INTEGER, show_activity INTEGER NOT NULL DEFAULT 1, federation_registry_updated_at INTEGER DEFAULT 0, `federation_heal_pending` integer DEFAULT 0, `federation_home_orphaned` integer DEFAULT 0, `last_active_day` text, `last_client` text, `chosen_status` text DEFAULT 'online' NOT NULL);
CREATE TABLE "voice_restrictions" (
          space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          restriction_type TEXT NOT NULL,
          moderator_id TEXT REFERENCES users(id),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (space_id, user_id, restriction_type)
        );
CREATE UNIQUE INDEX `federation_peers_origin_unique` ON `federation_peers` (`origin`);
CREATE INDEX idx_attachments_dm_message_id ON attachments(dm_message_id);
CREATE INDEX idx_attachments_message_id ON attachments(message_id);
CREATE INDEX idx_bans_space_id ON bans(space_id);
CREATE INDEX idx_category_overrides_category_id ON category_overrides(category_id);
CREATE INDEX idx_channel_categories_space_id ON channel_categories(space_id);
CREATE INDEX idx_channel_overrides_channel_id ON channel_overrides(channel_id);
CREATE INDEX idx_channels_space_id ON channels(space_id);
CREATE UNIQUE INDEX idx_dm_federated ON dm_channels(federated_id) WHERE federated_id IS NOT NULL;
CREATE INDEX idx_dm_members_user_id ON dm_members(user_id);
CREATE INDEX idx_dm_messages_dm_channel_id ON dm_messages(dm_channel_id);
CREATE UNIQUE INDEX idx_dm_messages_source_unique ON dm_messages(source_instance, source_message_id) WHERE source_instance IS NOT NULL;
CREATE INDEX idx_dm_messages_user_id ON dm_messages(user_id);
CREATE INDEX idx_dm_reactions_dm_message_id ON dm_reactions(dm_message_id);
CREATE INDEX idx_embeds_dm_message_id ON embeds(dm_message_id);
CREATE INDEX idx_embeds_message_id ON embeds(message_id);
CREATE INDEX idx_friend_requests_from_id ON friend_requests(from_id);
CREATE INDEX `idx_friend_requests_relay_message_id` ON `friend_requests` (`relay_message_id`);
CREATE INDEX idx_friend_requests_to_id ON friend_requests(to_id);
CREATE INDEX idx_friends_friend_id ON friends(friend_id);
CREATE INDEX idx_friends_user_id ON friends(user_id);
CREATE INDEX `idx_invite_links_created_at` ON `invite_links` (`created_at`);
CREATE INDEX `idx_invite_redemptions_invite_id` ON `invite_redemptions` (`invite_id`);
CREATE INDEX `idx_invite_redemptions_user_id` ON `invite_redemptions` (`user_id`);
CREATE INDEX idx_join_requests_space_id_status ON join_requests(space_id, status);
CREATE INDEX idx_member_roles_user_id_space_id ON member_roles(user_id, space_id);
CREATE INDEX idx_messages_channel_id ON messages(channel_id);
CREATE INDEX idx_messages_user_id ON messages(user_id);
CREATE INDEX idx_mutation_log_time ON federation_mutation_log(mutated_at);
CREATE INDEX idx_outbox_retry ON federation_outbox(next_retry_at);
CREATE INDEX `idx_peer_approval_notifications_user_id` ON `peer_approval_notifications` (`user_id`);
CREATE INDEX `idx_peer_approval_subscribers_user_id` ON `peer_approval_subscribers` (`user_id`);
CREATE INDEX idx_reactions_message_id ON reactions(message_id);
CREATE INDEX idx_read_states_user_id ON read_states(user_id);
CREATE INDEX idx_roles_space_id ON roles(space_id);
CREATE INDEX idx_space_members_user_id ON space_members(user_id);
CREATE INDEX `idx_users_home_user_id` ON `users` (`home_user_id`);
CREATE INDEX idx_voice_restrictions_space_id ON voice_restrictions(space_id);
CREATE UNIQUE INDEX `invite_links_token_unique` ON `invite_links` (`token`);
CREATE UNIQUE INDEX `peer_approval_requests_origin_direction_unique` ON `peer_approval_requests` (`origin`,`direction`);
CREATE UNIQUE INDEX `peer_approval_subscribers_request_id_user_id_trigger_reason_trigger_target_unique` ON `peer_approval_subscribers` (`request_id`,`user_id`,`trigger_reason`,`trigger_target`);
