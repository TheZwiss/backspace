ALTER TABLE `dm_messages` ADD `sticker_asset_id` text;--> statement-breakpoint
CREATE INDEX `idx_dm_messages_sticker_asset_id` ON `dm_messages` (`sticker_asset_id`);--> statement-breakpoint
ALTER TABLE `dm_reactions` ADD `sticker_asset_id` text;--> statement-breakpoint
CREATE INDEX `idx_dm_reactions_sticker_asset_id` ON `dm_reactions` (`sticker_asset_id`);--> statement-breakpoint
ALTER TABLE `messages` ADD `sticker_asset_id` text;--> statement-breakpoint
CREATE INDEX `idx_messages_sticker_asset_id` ON `messages` (`sticker_asset_id`);--> statement-breakpoint
ALTER TABLE `reactions` ADD `sticker_asset_id` text;--> statement-breakpoint
CREATE INDEX `idx_reactions_sticker_asset_id` ON `reactions` (`sticker_asset_id`);--> statement-breakpoint
UPDATE `messages` SET `sticker_asset_id` = substr(`content`, -69, 64) WHERE `content` GLOB 'sticker:http*://*/api/stickers/assets/*.webp';--> statement-breakpoint
UPDATE `dm_messages` SET `sticker_asset_id` = substr(`content`, -69, 64) WHERE `content` GLOB 'sticker:http*://*/api/stickers/assets/*.webp';--> statement-breakpoint
UPDATE `reactions` SET `sticker_asset_id` = substr(`emoji`, -69, 64) WHERE `emoji` GLOB 'sticker:http*://*/api/stickers/assets/*.webp';--> statement-breakpoint
UPDATE `dm_reactions` SET `sticker_asset_id` = substr(`emoji`, -69, 64) WHERE `emoji` GLOB 'sticker:http*://*/api/stickers/assets/*.webp';--> statement-breakpoint
CREATE TRIGGER `messages_sticker_asset_insert` AFTER INSERT ON `messages`
WHEN NEW.`content` GLOB 'sticker:http*://*/api/stickers/assets/*.webp'
BEGIN
  UPDATE `messages` SET `sticker_asset_id` = substr(NEW.`content`, -69, 64) WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `messages_sticker_asset_update` AFTER UPDATE OF `content` ON `messages`
BEGIN
  UPDATE `messages`
  SET `sticker_asset_id` = CASE
    WHEN NEW.`content` GLOB 'sticker:http*://*/api/stickers/assets/*.webp' THEN substr(NEW.`content`, -69, 64)
    ELSE NULL
  END
  WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `dm_messages_sticker_asset_insert` AFTER INSERT ON `dm_messages`
WHEN NEW.`content` GLOB 'sticker:http*://*/api/stickers/assets/*.webp'
BEGIN
  UPDATE `dm_messages` SET `sticker_asset_id` = substr(NEW.`content`, -69, 64) WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `dm_messages_sticker_asset_update` AFTER UPDATE OF `content` ON `dm_messages`
BEGIN
  UPDATE `dm_messages`
  SET `sticker_asset_id` = CASE
    WHEN NEW.`content` GLOB 'sticker:http*://*/api/stickers/assets/*.webp' THEN substr(NEW.`content`, -69, 64)
    ELSE NULL
  END
  WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `reactions_sticker_asset_insert` AFTER INSERT ON `reactions`
WHEN NEW.`emoji` GLOB 'sticker:http*://*/api/stickers/assets/*.webp'
BEGIN
  UPDATE `reactions` SET `sticker_asset_id` = substr(NEW.`emoji`, -69, 64) WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `reactions_sticker_asset_update` AFTER UPDATE OF `emoji` ON `reactions`
BEGIN
  UPDATE `reactions`
  SET `sticker_asset_id` = CASE
    WHEN NEW.`emoji` GLOB 'sticker:http*://*/api/stickers/assets/*.webp' THEN substr(NEW.`emoji`, -69, 64)
    ELSE NULL
  END
  WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `dm_reactions_sticker_asset_insert` AFTER INSERT ON `dm_reactions`
WHEN NEW.`emoji` GLOB 'sticker:http*://*/api/stickers/assets/*.webp'
BEGIN
  UPDATE `dm_reactions` SET `sticker_asset_id` = substr(NEW.`emoji`, -69, 64) WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `dm_reactions_sticker_asset_update` AFTER UPDATE OF `emoji` ON `dm_reactions`
BEGIN
  UPDATE `dm_reactions`
  SET `sticker_asset_id` = CASE
    WHEN NEW.`emoji` GLOB 'sticker:http*://*/api/stickers/assets/*.webp' THEN substr(NEW.`emoji`, -69, 64)
    ELSE NULL
  END
  WHERE `id` = NEW.`id`;
END;
