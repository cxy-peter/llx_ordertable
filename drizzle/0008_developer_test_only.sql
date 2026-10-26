ALTER TABLE `customers` ADD `login_name` text;--> statement-breakpoint
CREATE UNIQUE INDEX `customers_login_name_unique` ON `customers` (`login_name`);--> statement-breakpoint
ALTER TABLE `orders` ADD `created_by` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `test_only` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER developer_order_test_only AFTER INSERT ON orders
WHEN EXISTS(SELECT 1 FROM customers WHERE account_type='developer' AND (id=NEW.user_id OR id=NEW.created_by)) BEGIN
 UPDATE orders SET is_test=1,test_only=1 WHERE id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER preserve_developer_test_only BEFORE UPDATE OF is_test,test_only ON orders
WHEN OLD.test_only=1 AND (NEW.is_test<>1 OR NEW.test_only<>1) BEGIN
 SELECT RAISE(ABORT,'developer_order_test_only');
END;
