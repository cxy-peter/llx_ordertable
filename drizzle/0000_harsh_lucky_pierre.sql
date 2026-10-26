CREATE TABLE `attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `attempt_key_time` ON `attempts` (`key`,`created_at`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`phone` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`recovery_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_phone_unique` ON `customers` (`phone`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tx_guards` (
	`id` text PRIMARY KEY NOT NULL,
	`ok` integer NOT NULL,
	CONSTRAINT "must_match_version" CHECK("tx_guards"."ok"=1)
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`user_id` text NOT NULL,
	`idem_hash` text NOT NULL,
	`payload_hash` text NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`wechat` text DEFAULT '' NOT NULL,
	`pickup` text NOT NULL,
	`pickup_info` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`session` text NOT NULL,
	`date` text NOT NULL,
	`slot` text NOT NULL,
	`items` text NOT NULL,
	`subtotal` integer NOT NULL,
	`tax` integer NOT NULL,
	`fee` integer NOT NULL,
	`total` integer NOT NULL,
	`phase` text DEFAULT 'draft' NOT NULL,
	`payment` text DEFAULT 'unpaid' NOT NULL,
	`fulfillment` text DEFAULT 'pending' NOT NULL,
	`channel` text DEFAULT '' NOT NULL,
	`payer` text DEFAULT '' NOT NULL,
	`transaction_id` text DEFAULT '' NOT NULL,
	`receipt` text,
	`arrival_photo` text,
	`received_amount` integer,
	`received_currency` text,
	`exchange_basis` text,
	`verified_by` text,
	`verified_at` text,
	`submitted_at` text,
	`source` text DEFAULT 'customer' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_public_id_unique` ON `orders` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_idem_hash_unique` ON `orders` (`idem_hash`);--> statement-breakpoint
CREATE INDEX `order_user` ON `orders` (`user_id`);--> statement-breakpoint
CREATE INDEX `order_date_phase` ON `orders` (`date`,`phase`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`expires` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
