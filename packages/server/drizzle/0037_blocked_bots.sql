CREATE TABLE `blocked_bots` (
  `home_instance` text NOT NULL,
  `home_user_id` text NOT NULL,
  `username` text NOT NULL,
  `blocked_by` text,
  `created_at` integer NOT NULL,
  PRIMARY KEY(`home_instance`, `home_user_id`),
  FOREIGN KEY (`blocked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
