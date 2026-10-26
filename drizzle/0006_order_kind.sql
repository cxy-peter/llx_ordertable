ALTER TABLE `customers` ADD `account_type` text DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE `order_history` ADD `is_test` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `is_test` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX order_accounting_scope ON orders(is_test,date,phase,id);
