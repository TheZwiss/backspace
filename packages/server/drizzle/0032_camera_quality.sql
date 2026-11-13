ALTER TABLE `instance_settings` ADD `camera_mode` text DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `camera_default_resolution` integer DEFAULT 720 NOT NULL;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `camera_default_framerate` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `camera_default_bitrate_kbps` integer DEFAULT 2000 NOT NULL;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `camera_allowed_resolutions` text DEFAULT '540,720,1080' NOT NULL;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `camera_allowed_framerates` text DEFAULT '30,60' NOT NULL;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `camera_min_bitrate_kbps` integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `camera_max_bitrate_kbps` integer DEFAULT 4000 NOT NULL;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `camera_allow_custom_bitrate` integer DEFAULT 1 NOT NULL;