CREATE TABLE `cost_counters` (
	`key` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cost_objects` (
	`key` text PRIMARY KEY NOT NULL,
	`bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customer_codes` (
	`code` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_codes_user_id_unique` ON `customer_codes` (`user_id`);--> statement-breakpoint
CREATE TABLE `order_references` (
	`order_id` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`customer_code` integer NOT NULL,
	`customer_sequence` integer NOT NULL,
	`day_sequence` integer NOT NULL,
	`date` text NOT NULL,
	`order_created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reference_user_day` ON `order_references` (`user_id`,`date`,`customer_sequence`);--> statement-breakpoint
CREATE INDEX `reference_day` ON `order_references` (`date`,`day_sequence`);--> statement-breakpoint
ALTER TABLE `orders` ADD `arrived_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `auto_confirm_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `confirmed_at` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `confirmed_by` text;
--> statement-breakpoint
INSERT OR IGNORE INTO customer_codes(user_id) SELECT id FROM customers ORDER BY created_at,id;
--> statement-breakpoint
INSERT OR IGNORE INTO customer_codes(user_id) SELECT user_id FROM orders UNION SELECT user_id FROM order_history;
--> statement-breakpoint
INSERT INTO order_references(order_id,user_id,customer_code,customer_sequence,day_sequence,date,order_created_at)
SELECT source.id,source.user_id,c.code,row_number() OVER(PARTITION BY source.user_id,source.date ORDER BY source.id),row_number() OVER(PARTITION BY source.date ORDER BY source.id),source.date,source.created_at
FROM (SELECT id,user_id,date,created_at FROM orders UNION ALL SELECT id,user_id,date,date||'T00:00:00.000Z' FROM order_history WHERE id NOT IN (SELECT id FROM orders)) source JOIN customer_codes c ON c.user_id=source.user_id;
--> statement-breakpoint
CREATE UNIQUE INDEX reference_daily_unique ON order_references(date,day_sequence);
--> statement-breakpoint
CREATE UNIQUE INDEX reference_customer_unique ON order_references(user_id,date,customer_sequence);
--> statement-breakpoint
CREATE TRIGGER customer_assign_code AFTER INSERT ON customers BEGIN
 INSERT OR IGNORE INTO customer_codes(user_id) VALUES(NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER order_assign_reference AFTER INSERT ON orders BEGIN
 INSERT OR IGNORE INTO customer_codes(user_id) VALUES(NEW.user_id);
 INSERT INTO order_references(order_id,user_id,customer_code,customer_sequence,day_sequence,date,order_created_at)
 SELECT NEW.id,NEW.user_id,(SELECT code FROM customer_codes WHERE user_id=NEW.user_id),coalesce((SELECT max(customer_sequence) FROM order_references WHERE user_id=NEW.user_id AND date=NEW.date),0)+1,coalesce((SELECT max(day_sequence) FROM order_references WHERE date=NEW.date),0)+1,NEW.date,NEW.created_at;
 SELECT CASE WHEN (SELECT day_sequence FROM order_references WHERE order_id=NEW.id)>9999 THEN RAISE(ABORT,'daily_display_number_limit') END;
 SELECT CASE WHEN (SELECT customer_sequence FROM order_references WHERE order_id=NEW.id)>999 THEN RAISE(ABORT,'customer_display_number_limit') END;
END;
--> statement-breakpoint
CREATE VIEW order_details AS SELECT o.*,r.customer_code,r.customer_sequence,r.day_sequence,r.order_created_at FROM orders o LEFT JOIN order_references r ON r.order_id=o.id;
--> statement-breakpoint
CREATE INDEX order_auto_confirm ON orders(auto_confirm_at) WHERE phase='submitted' AND fulfillment='arrived' AND payment='verified';
--> statement-breakpoint
CREATE INDEX order_outstanding ON orders(date) WHERE phase='submitted' AND (payment IN ('review','exception','refund_pending') OR (payment='verified' AND fulfillment NOT IN ('collected','cancelled')));
--> statement-breakpoint
UPDATE orders SET arrived_at=updated_at,auto_confirm_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes') WHERE fulfillment='arrived';
