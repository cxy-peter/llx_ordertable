CREATE TABLE `push_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `push_attempt_time` ON `push_attempts` (`created_at`);--> statement-breakpoint
ALTER TABLE `push_jobs` ADD `callback_token` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `push_jobs` ADD `provider_ref` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `push_callback` ON `push_jobs` (`callback_token`);--> statement-breakpoint
ALTER TABLE `push_settings` ADD `provider` text DEFAULT 'pushplus' NOT NULL;--> statement-breakpoint
ALTER TABLE `push_settings` ADD `paused_reason` text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE push_settings SET daily_limit=180 WHERE provider='pushplus' AND daily_limit>180;
