ALTER TABLE `federation_peers` RENAME COLUMN "needs_attention_reason" TO "status_reason";--> statement-breakpoint
-- Hand-written data steps (not generated).
-- 1. Before this migration the column was only meaningful for needs_attention,
-- and a row leaving needs_attention (an admin's deny, a revoke) could keep the
-- old value. A reason now also tells a rejected row which side refused, so a
-- leftover value on any other status would be read as a refusal by the remote.
-- Keep only the reasons that match the row's status: an existing rejected row
-- gets a NULL reason, which keeps the behaviour it had, since which side
-- refused cannot be recovered from the row.
UPDATE `federation_peers` SET `status_reason` = NULL
WHERE `status` <> 'needs_attention';--> statement-breakpoint
-- 2. The auth-failure threshold moved a peer to needs_attention without writing
-- a reason; every other path into needs_attention wrote one. So a
-- needs_attention row with no reason can only have come from that threshold.
UPDATE `federation_peers` SET `status_reason` = 'auth_failures'
WHERE `status` = 'needs_attention' AND `status_reason` IS NULL;
