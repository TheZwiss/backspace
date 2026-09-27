-- Data only. Relabel the rows the old POST /api/federation/peer/ensure wrote.
-- That endpoint recorded every call as 'friend_add' with the remote origin
-- (URL.origin, e.g. 'https://orbit.example') as target, but its only callers
-- were connection flows. The new code writes 'instance_connect' with the same
-- target, so only the reason changes.
--
-- A genuine friend add has a 'name@domain' target (routes/social.ts), and
-- usernames are [a-z0-9_]+, so a target that starts with 'http://' or
-- 'https://' and contains no '@' can only have come from /peer/ensure.
--
-- Idempotent: once relabelled, no row matches the predicate any more.
--
-- Subscribers first drop a legacy row whose relabelled twin already exists
-- (the same user asked again after the fix), which would otherwise collide
-- with UNIQUE (request_id, user_id, trigger_reason, trigger_target).
DELETE FROM `peer_approval_subscribers`
WHERE `trigger_reason` = 'friend_add'
  AND (substr(`trigger_target`, 1, 8) = 'https://' OR substr(`trigger_target`, 1, 7) = 'http://')
  AND instr(`trigger_target`, '@') = 0
  AND EXISTS (
    SELECT 1 FROM `peer_approval_subscribers` AS `twin`
    WHERE `twin`.`request_id` = `peer_approval_subscribers`.`request_id`
      AND `twin`.`user_id` = `peer_approval_subscribers`.`user_id`
      AND `twin`.`trigger_reason` = 'instance_connect'
      AND `twin`.`trigger_target` = `peer_approval_subscribers`.`trigger_target`
  );
--> statement-breakpoint
UPDATE `peer_approval_subscribers`
SET `trigger_reason` = 'instance_connect'
WHERE `trigger_reason` = 'friend_add'
  AND (substr(`trigger_target`, 1, 8) = 'https://' OR substr(`trigger_target`, 1, 7) = 'http://')
  AND instr(`trigger_target`, '@') = 0;
--> statement-breakpoint
UPDATE `peer_approval_notifications`
SET `trigger_reason` = 'instance_connect'
WHERE `trigger_reason` = 'friend_add'
  AND (substr(`trigger_target`, 1, 8) = 'https://' OR substr(`trigger_target`, 1, 7) = 'http://')
  AND instr(`trigger_target`, '@') = 0;
