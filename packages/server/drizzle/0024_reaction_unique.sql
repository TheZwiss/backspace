-- Hand-written data steps (not generated).
-- Installs created from the squashed 0000 have no unique key on a reaction's
-- (message, user, emoji), so the same user could store the same reaction more
-- than once. Keep the earliest row of each key (lowest created_at, then the
-- first inserted) and delete the rest, so the unique indexes below can be
-- created. Installs from before the squash already carry an inline UNIQUE on
-- these columns and have no such rows; there the new index sits beside it.
DELETE FROM `dm_reactions` WHERE EXISTS (
	SELECT 1 FROM `dm_reactions` AS `kept`
	WHERE `kept`.`dm_message_id` = `dm_reactions`.`dm_message_id`
		AND `kept`.`user_id` = `dm_reactions`.`user_id`
		AND `kept`.`emoji` = `dm_reactions`.`emoji`
		AND (`kept`.`created_at` < `dm_reactions`.`created_at`
			OR (`kept`.`created_at` = `dm_reactions`.`created_at` AND `kept`.`rowid` < `dm_reactions`.`rowid`))
);--> statement-breakpoint
DELETE FROM `reactions` WHERE EXISTS (
	SELECT 1 FROM `reactions` AS `kept`
	WHERE `kept`.`message_id` = `reactions`.`message_id`
		AND `kept`.`user_id` = `reactions`.`user_id`
		AND `kept`.`emoji` = `reactions`.`emoji`
		AND (`kept`.`created_at` < `reactions`.`created_at`
			OR (`kept`.`created_at` = `reactions`.`created_at` AND `kept`.`rowid` < `reactions`.`rowid`))
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_dm_reactions_message_user_emoji` ON `dm_reactions` (`dm_message_id`,`user_id`,`emoji`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reactions_message_user_emoji` ON `reactions` (`message_id`,`user_id`,`emoji`);
