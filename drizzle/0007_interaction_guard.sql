CREATE TABLE `interaction_guards` (
	`key` text PRIMARY KEY NOT NULL,
	`window_started` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`blocked` integer DEFAULT 0 NOT NULL,
	`challenge_id` text DEFAULT '' NOT NULL,
	`question` text DEFAULT '' NOT NULL,
	`answer_hash` text DEFAULT '' NOT NULL,
	`expires` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `interaction_expiry` ON `interaction_guards` (`updated_at`);