PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_profile_dealers` (
	`search_profile_id` text NOT NULL,
	`dealer_id` text NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`bound_at` numeric DEFAULT (CURRENT_TIMESTAMP),
	`exclusion_reason` text,
	PRIMARY KEY(`search_profile_id`, `dealer_id`),
	CONSTRAINT "ck_profile_dealers_status" CHECK(status IN ('candidate', 'bound', 'excluded_conflict', 'closed_out'))
);
--> statement-breakpoint
INSERT INTO `__new_profile_dealers`("search_profile_id", "dealer_id", "status", "bound_at", "exclusion_reason") SELECT "search_profile_id", "dealer_id", "status", "bound_at", "exclusion_reason" FROM `profile_dealers`;--> statement-breakpoint
DROP TABLE `profile_dealers`;--> statement-breakpoint
ALTER TABLE `__new_profile_dealers` RENAME TO `profile_dealers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_profile_dealers_dealer` ON `profile_dealers` (`dealer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_profile_dealers_bound_dealer` ON `profile_dealers` (`dealer_id`) WHERE status = 'bound';