CREATE TABLE `challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`ip_hash` text NOT NULL,
	`answer_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `customers` ADD `wechat` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `customers` ADD `disabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_active` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `idle_exempt` integer DEFAULT 0 NOT NULL;