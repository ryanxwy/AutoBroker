CREATE TABLE `fake_mailbox_attachments` (
	`attachment_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`data_base64` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `fake_mailbox_messages`(`message_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_fake_mailbox_attachments_message` ON `fake_mailbox_attachments` (`message_id`);--> statement-breakpoint
CREATE TABLE `fake_mailbox_messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`raw` text NOT NULL,
	`to` text NOT NULL,
	`from` text NOT NULL,
	`subject` text,
	`internal_date_ms` integer NOT NULL,
	`direction` text NOT NULL,
	`is_delivered` integer DEFAULT 1 NOT NULL,
	`search_profile_id` text,
	FOREIGN KEY (`thread_id`) REFERENCES `fake_mailbox_threads`(`thread_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_fake_mailbox_messages_direction" CHECK(direction IN ('inbound', 'outbound')),
	CONSTRAINT "ck_fake_mailbox_messages_is_delivered_bool" CHECK(is_delivered IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `idx_fake_mailbox_messages_thread` ON `fake_mailbox_messages` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_fake_mailbox_messages_internal_date` ON `fake_mailbox_messages` (`internal_date_ms`);--> statement-breakpoint
CREATE INDEX `idx_fake_mailbox_messages_profile` ON `fake_mailbox_messages` (`search_profile_id`);--> statement-breakpoint
CREATE TABLE `fake_mailbox_threads` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`subject` text,
	`search_profile_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_fake_mailbox_threads_profile` ON `fake_mailbox_threads` (`search_profile_id`);--> statement-breakpoint
CREATE TABLE `sandbox_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` numeric DEFAULT (CURRENT_TIMESTAMP)
);
