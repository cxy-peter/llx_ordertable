CREATE TABLE `cleanup_plans` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`session_hash` text NOT NULL,
	`orders` text NOT NULL,
	`archive_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `media_garbage` (
	`key` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order_history` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`slot` text NOT NULL,
	`items` text NOT NULL,
	`pickup` text NOT NULL,
	`pickup_name` text NOT NULL,
	`archived_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `history_user` ON `order_history` (`user_id`,`id`);--> statement-breakpoint
ALTER TABLE `customers` ADD `profile` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `customers` ADD `profile_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `prep` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `closed_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `media_removed_at` text;