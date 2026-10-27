CREATE TABLE `push_daily` (
	`day` text PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`order_id` integer,
	`generation` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`next_attempt` integer NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`claim_token` text DEFAULT '' NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `push_due` ON `push_jobs` (`status`,`next_attempt`);--> statement-breakpoint
CREATE INDEX `push_cleanup` ON `push_jobs` (`created_at`);--> statement-breakpoint
CREATE TABLE `push_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`device_key` text DEFAULT '' NOT NULL,
	`title` text DEFAULT '车队配送单' NOT NULL,
	`message` text DEFAULT '有新订单，请核款接单。' NOT NULL,
	`daily_limit` integer DEFAULT 200 NOT NULL,
	`site_origin` text DEFAULT '' NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "push_settings_singleton" CHECK("push_settings"."id"=1)
);

--> statement-breakpoint
INSERT INTO push_settings(id) VALUES(1);
--> statement-breakpoint
CREATE TRIGGER enqueue_new_order_push AFTER INSERT ON events
WHEN NEW.action='正式提交给商家' OR NEW.action='创建订单'
BEGIN
 INSERT OR IGNORE INTO push_jobs(id,kind,order_id,generation,created_at,next_attempt)
 SELECT 'order:'||o.id,'order',o.id,s.generation,unixepoch()*1000,unixepoch()*1000
 FROM orders o CROSS JOIN push_settings s
 WHERE o.id=NEW.order_id AND o.phase='submitted' AND o.is_test=0 AND o.test_only=0
 AND s.id=1 AND s.enabled=1 AND s.device_key<>''
 AND (NEW.action='正式提交给商家' OR o.source='staff');
END;
