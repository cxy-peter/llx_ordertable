CREATE INDEX `attempt_cleanup` ON `attempts` (`created_at`);--> statement-breakpoint
CREATE INDEX `challenge_expiry` ON `challenges` (`expires`);--> statement-breakpoint
CREATE INDEX `event_order` ON `events` (`order_id`,`id`);--> statement-breakpoint
CREATE INDEX `event_action` ON `events` (`action`,`id`);--> statement-breakpoint
CREATE INDEX `session_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `session_expiry` ON `sessions` (`expires`);