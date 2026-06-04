CREATE TABLE `accounts` (
	`account_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`oauth_ref` text,
	`created_at` numeric DEFAULT (CURRENT_TIMESTAMP)
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`audit_id` text PRIMARY KEY NOT NULL,
	`at` numeric DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`actor` text,
	`action` text NOT NULL,
	`target_table` text,
	`target_id` text,
	`search_profile_id` text,
	`field` text,
	`old_value` text,
	`new_value` text,
	`reason` text,
	`payload_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_audit_log_target` ON `audit_log` (`target_table`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_at` ON `audit_log` (`at`);--> statement-breakpoint
CREATE TABLE `dealer_contacts` (
	`contact_id` text PRIMARY KEY NOT NULL,
	`dealer_id` text NOT NULL,
	`email` text,
	`display_name` text,
	`normalized_email` text NOT NULL,
	`role` text,
	`role_confidence` real,
	`seniority_rank` integer,
	`phone` text,
	`first_seen_at` numeric,
	`last_seen_at` numeric,
	`is_primary_reply_target` integer DEFAULT 0,
	`source` text,
	`preferred_score` integer DEFAULT 0,
	`score_reason` text,
	`is_crm_platform_sender` integer DEFAULT 0,
	`search_profile_id` text,
	FOREIGN KEY (`dealer_id`) REFERENCES `dealers`(`dealer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_dealer_contacts_lookup` ON `dealer_contacts` (`dealer_id`,`normalized_email`);--> statement-breakpoint
CREATE TABLE `dealer_inventory_sources` (
	`source_id` text PRIMARY KEY NOT NULL,
	`search_profile_id` text NOT NULL,
	`dealer_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_url` text NOT NULL,
	`normalized_url` text NOT NULL,
	`discovery_method` text NOT NULL,
	`parent_source_id` text,
	`first_seen_at` numeric NOT NULL,
	`last_scanned_at` numeric,
	`last_status` text NOT NULL,
	`blocked_count` integer DEFAULT 0 NOT NULL,
	`error_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_dis_status` ON `dealer_inventory_sources` (`last_status`);--> statement-breakpoint
CREATE INDEX `idx_dis_profile_dealer` ON `dealer_inventory_sources` (`search_profile_id`,`dealer_id`);--> statement-breakpoint
CREATE TABLE `dealer_quotes` (
	`quote_id` text PRIMARY KEY NOT NULL,
	`dealer_id` text NOT NULL,
	`message_id` text NOT NULL,
	`source_gmail_message_id` text NOT NULL,
	`search_profile_id` text NOT NULL,
	`vin` text,
	`inventory_status` text,
	`msrp` real,
	`selling_price` real,
	`dealer_discount` real,
	`rebates_json` text,
	`doc_fee` real,
	`dealer_fee` real,
	`sales_tax` real,
	`dmv_fees` real,
	`title_fee` real,
	`registration_fee` real,
	`license_fee` real,
	`other_fees_json` text,
	`add_ons_json` text,
	`taxable_rebates_json` text,
	`otd_total` real,
	`quote_format` text,
	`intent` text,
	`confidence` real,
	`raw_source_blob` text,
	`quote_received_at` numeric,
	`quote_expires_at` numeric,
	`extracted_at` numeric,
	`extractor_provider` text,
	`extraction_method` text,
	`financing_mode` text NOT NULL,
	`finance_apr` real,
	`finance_term_months` integer,
	`finance_down_payment` real,
	`finance_monthly_payment` real,
	`finance_amount_financed` real,
	`lease_term_months` integer,
	`lease_money_factor` real,
	`lease_residual_pct` real,
	`lease_residual_value` real,
	`lease_due_at_signing` real,
	`lease_monthly_payment` real,
	`lease_miles_per_year` integer,
	`lease_acquisition_fee` real,
	`lease_disposition_fee` real,
	`lease_cap_cost_gross` real,
	`lease_cap_cost_adjusted` real,
	`lease_rent_charge` real,
	`source_listing_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_dealer_quotes_dealer_profile` ON `dealer_quotes` (`dealer_id`,`search_profile_id`);--> statement-breakpoint
CREATE INDEX `idx_dealer_quotes_profile_received` ON `dealer_quotes` (`search_profile_id`,`quote_received_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_dealer_quotes_source_msg` ON `dealer_quotes` (`source_gmail_message_id`,`financing_mode`);--> statement-breakpoint
CREATE TABLE `dealers` (
	`dealer_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`address` text,
	`city` text,
	`state` text,
	`postal_code` text,
	`phone` text,
	`website` text,
	`contact_email` text,
	`google_place_id` text,
	`latitude` real,
	`longitude` real,
	`distance_miles` real,
	`rating` real,
	`review_count` integer,
	`country` text DEFAULT 'US' NOT NULL,
	CONSTRAINT "ck_dealers_country" CHECK(country IN ('US', 'CA', 'MX'))
);
--> statement-breakpoint
CREATE INDEX `idx_dealers_country` ON `dealers` (`country`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_dealers_place_id` ON `dealers` (`google_place_id`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`run_id` text NOT NULL,
	`decision_id` text NOT NULL,
	`form_kind` text NOT NULL,
	`spec_path` text NOT NULL,
	`spec_inline` text NOT NULL,
	`client_id` text,
	`created_at` numeric DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`consumed_at` numeric,
	PRIMARY KEY(`run_id`, `decision_id`)
);
--> statement-breakpoint
CREATE INDEX `ix_decisions_run_id_consumed_at` ON `decisions` (`run_id`,`consumed_at`);--> statement-breakpoint
CREATE TABLE `inventory_listings` (
	`listing_id` text PRIMARY KEY NOT NULL,
	`search_profile_id` text NOT NULL,
	`dealer_id` text NOT NULL,
	`source_id` text,
	`vin` text,
	`stock_number` text,
	`year` integer,
	`make` text,
	`model` text,
	`trim` text,
	`exterior_color` text,
	`interior_color` text,
	`drivetrain` text,
	`powertrain` text,
	`feature_text` text,
	`packages_json` text,
	`msrp` real,
	`listed_price` real,
	`dealer_discount` real,
	`incentives_text` text,
	`inventory_status` text NOT NULL,
	`listing_url` text,
	`normalized_listing_url` text,
	`match_status` text NOT NULL,
	`raw_listing_json` text NOT NULL,
	`first_seen_at` numeric NOT NULL,
	`last_seen_at` numeric NOT NULL,
	`observed_at` numeric NOT NULL,
	`superseded_at` numeric,
	`superseded_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_il_url_fallback` ON `inventory_listings` (`search_profile_id`,`dealer_id`,`normalized_listing_url`) WHERE vin IS NULL;--> statement-breakpoint
CREATE INDEX `idx_il_freshness` ON `inventory_listings` (`last_seen_at`);--> statement-breakpoint
CREATE INDEX `idx_il_dealer` ON `inventory_listings` (`dealer_id`);--> statement-breakpoint
CREATE INDEX `idx_il_profile_match` ON `inventory_listings` (`search_profile_id`,`match_status`);--> statement-breakpoint
CREATE INDEX `idx_il_profile` ON `inventory_listings` (`search_profile_id`);--> statement-breakpoint
CREATE TABLE `lead_submissions` (
	`submission_id` text PRIMARY KEY NOT NULL,
	`dealer_id` text NOT NULL,
	`form_url` text,
	`submitted_email` text,
	`comment_text` text,
	`screenshot_path` text,
	`search_profile_id` text,
	`source_listing_id` text,
	`submitted_at` numeric,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`submission_channel` text,
	`fail_reason` text,
	`email_fallback_reason` text,
	FOREIGN KEY (`dealer_id`) REFERENCES `dealers`(`dealer_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_lead_submissions_xor" CHECK((outcome = 'pending' AND submission_channel IS NULL AND fail_reason IS NULL AND email_fallback_reason IS NULL) OR (outcome = 'submitted' AND submission_channel IS NOT NULL AND submission_channel IN ('web_form','email') AND fail_reason IS NULL AND ((submission_channel = 'email' AND email_fallback_reason IS NOT NULL AND email_fallback_reason IN ('no_form','captcha_fallback','user_override')) OR (submission_channel = 'web_form' AND email_fallback_reason IS NULL))) OR (outcome = 'failed' AND submission_channel IS NULL AND email_fallback_reason IS NULL AND fail_reason IS NOT NULL AND fail_reason IN ('captcha_blocked','form_not_found','site_unreachable','form_rejected','user_skipped','unknown')))
);
--> statement-breakpoint
CREATE TABLE `manufacturer_incentives` (
	`id` integer PRIMARY KEY NOT NULL,
	`make` text NOT NULL,
	`model` text NOT NULL,
	`zip` text NOT NULL,
	`type` text NOT NULL,
	`amount` real NOT NULL,
	`expires` numeric,
	`eligibility` text NOT NULL,
	`scraped_at` numeric NOT NULL,
	`scrape_source_url` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_mfr_incentives_lookup` ON `manufacturer_incentives` (`make`,`model`,`zip`,`expires`);--> statement-breakpoint
CREATE TABLE `message_analysis` (
	`analysis_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`contact_id` text,
	`analysis_version` integer DEFAULT 1 NOT NULL,
	`is_current` integer DEFAULT 1 NOT NULL,
	`intent` text,
	`summary_short` text,
	`summary_bullets_json` text,
	`quote_signal` text,
	`needs_response` integer DEFAULT 0,
	`reply_priority` integer DEFAULT 3,
	`promised_follow_up_at` numeric,
	`confidence` real,
	`raw_extract_json` text,
	`search_profile_id` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `dealer_contacts`(`contact_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_message_analysis_version" CHECK(analysis_version >= 1),
	CONSTRAINT "ck_message_analysis_is_current_bool" CHECK(is_current IN (0, 1)),
	CONSTRAINT "ck_message_analysis_needs_response_bool" CHECK(needs_response IN (0, 1)),
	CONSTRAINT "ck_message_analysis_reply_priority_range" CHECK(reply_priority BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE INDEX `idx_message_analysis_contact_current` ON `message_analysis` (`contact_id`,`is_current`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_message_analysis_current` ON `message_analysis` (`message_id`) WHERE is_current = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_message_analysis_message_version` ON `message_analysis` (`message_id`,`analysis_version`);--> statement-breakpoint
CREATE TABLE `message_attachments` (
	`attachment_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`storage_path` text NOT NULL,
	`sha256` text,
	`created_at` numeric DEFAULT (CURRENT_TIMESTAMP),
	`fetched_at` numeric,
	`is_orphaned` numeric NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_message_attachments_message_id` ON `message_attachments` (`message_id`);--> statement-breakpoint
CREATE TABLE `message_claims` (
	`claim_id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`claim_type` text NOT NULL,
	`claim_text` text NOT NULL,
	`confidence` real,
	`search_profile_id` text,
	FOREIGN KEY (`analysis_id`) REFERENCES `message_analysis`(`analysis_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_message_claims_analysis_id` ON `message_claims` (`analysis_id`);--> statement-breakpoint
CREATE TABLE `message_questions` (
	`question_id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`question_type` text NOT NULL,
	`question_text` text NOT NULL,
	`status` text DEFAULT 'needs_user_input' NOT NULL,
	`search_profile_id` text,
	FOREIGN KEY (`analysis_id`) REFERENCES `message_analysis`(`analysis_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_message_questions_status" CHECK(status IN ('answerable_from_profile', 'needs_user_input', 'informational_only'))
);
--> statement-breakpoint
CREATE INDEX `idx_message_questions_status` ON `message_questions` (`status`,`analysis_id`);--> statement-breakpoint
CREATE INDEX `idx_message_questions_analysis_id` ON `message_questions` (`analysis_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`thread_id` text,
	`gmail_message_id` text,
	`direction` text NOT NULL,
	`sender` text,
	`recipient` text,
	`subject` text,
	`body_text` text,
	`received_at` numeric,
	`processed_at` numeric,
	`key_info_json` text,
	`contact_id` text,
	`sender_email` text,
	`sender_name` text,
	`search_profile_id` text,
	`quote_extraction_status` text DEFAULT 'pending',
	`quote_extraction_intent` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`thread_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_messages_quote_extraction_status_intent" CHECK((quote_extraction_status = 'pending' AND quote_extraction_intent IS NULL) OR (quote_extraction_status = 'succeeded' AND quote_extraction_intent IS NOT NULL) OR (quote_extraction_status = 'failed' AND quote_extraction_intent IS NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_messages_sender_email` ON `messages` (`sender_email`);--> statement-breakpoint
CREATE INDEX `idx_messages_contact_id` ON `messages` (`contact_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_thread_id` ON `messages` (`thread_id`);--> statement-breakpoint
CREATE TABLE `offers` (
	`offer_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`dealer_id` text NOT NULL,
	`message_id` text,
	`vin` text,
	`selling_price` real,
	`otd_estimate` real,
	`msrp` real,
	`fees_json` text,
	`add_ons_json` text,
	`inventory_status` text,
	`confidence` real,
	`vs_market_json` text,
	`source_snippet` text,
	`verification_notes` text,
	`search_profile_id` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`thread_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dealer_id`) REFERENCES `dealers`(`dealer_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_offers_dealer_id` ON `offers` (`dealer_id`);--> statement-breakpoint
CREATE TABLE `pipeline_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` numeric DEFAULT (CURRENT_TIMESTAMP),
	`search_profile_id` text
);
--> statement-breakpoint
CREATE TABLE `profile_dealers` (
	`search_profile_id` text NOT NULL,
	`dealer_id` text NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`bound_at` numeric DEFAULT (CURRENT_TIMESTAMP),
	`exclusion_reason` text,
	PRIMARY KEY(`search_profile_id`, `dealer_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_profile_dealers_dealer` ON `profile_dealers` (`dealer_id`);--> statement-breakpoint
CREATE TABLE `quote_audits` (
	`audit_id` integer PRIMARY KEY NOT NULL,
	`dealer_quote_id` text NOT NULL,
	`search_profile_id` text NOT NULL,
	`flags_json` text NOT NULL,
	`audited_at` numeric NOT NULL,
	`audit_pass_version` text NOT NULL,
	FOREIGN KEY (`dealer_quote_id`) REFERENCES `dealer_quotes`(`quote_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_quote_audits_profile_audited` ON `quote_audits` (`search_profile_id`,`audited_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_quote_audits_quote_pass` ON `quote_audits` (`dealer_quote_id`,`audit_pass_version`);--> statement-breakpoint
CREATE TABLE `search_profiles` (
	`search_profile_id` text PRIMARY KEY NOT NULL,
	`year` integer NOT NULL,
	`make` text NOT NULL,
	`model` text NOT NULL,
	`trim` text,
	`budget_max` real,
	`search_radius_miles` integer DEFAULT 25,
	`location_query` text,
	`resolved_address` text,
	`city` text,
	`state` text,
	`postal_code` text,
	`country` text DEFAULT 'US',
	`latitude` real,
	`longitude` real,
	`follow_up_email` text,
	`follow_up_phone` text,
	`phone_policy` text DEFAULT 'fake',
	`fake_phone` text,
	`financing_preference` text,
	`trade_in_description` text,
	`military_first_responder` integer DEFAULT 0,
	`current_brand_owner` integer DEFAULT 0,
	`preferred_exterior_colors_json` text,
	`preferred_interior_colors_json` text,
	`acceptable_trims_json` text,
	`feature_preferences_json` text,
	`account_id` text,
	`brand` text,
	`location` text,
	`status` text,
	`superseded_by` text,
	`updated_at` numeric
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_search_profiles_active_account_brand` ON `search_profiles` (`account_id`,`brand`) WHERE status = 'active';--> statement-breakpoint
CREATE TABLE `session_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_session_turns_kind" CHECK(kind IN ('user'))
);
--> statement-breakpoint
CREATE INDEX `idx_session_turns_session` ON `session_turns` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`created_at` text NOT NULL,
	`last_activity_at` text NOT NULL,
	`pinned_profile_id` text,
	`archived` integer DEFAULT 0 NOT NULL,
	`provider` text DEFAULT 'anthropic' NOT NULL,
	`auth_mode` text DEFAULT 'oauth' NOT NULL,
	`driver_kind` text DEFAULT 'agent' NOT NULL,
	`model` text DEFAULT 'default' NOT NULL,
	FOREIGN KEY (`pinned_profile_id`) REFERENCES `search_profiles`(`search_profile_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_last_activity` ON `sessions` (`last_activity_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_archived` ON `sessions` (`archived`);--> statement-breakpoint
CREATE TABLE `skill_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`skill_name` text NOT NULL,
	`search_profile_id` text,
	`started_at` numeric NOT NULL,
	`finished_at` numeric,
	`status` text NOT NULL,
	`input_json` text,
	`summary_text` text,
	`transcript_json` text,
	`session_id` text,
	`idempotency_key` text,
	`transport_state` text DEFAULT 'connected',
	`last_heartbeat_at` numeric,
	`dispatched_skill_name` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_skill_runs_idempotency_key` ON `skill_runs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_skill_runs_session` ON `skill_runs` (`session_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_runs_profile_started` ON `skill_runs` (`search_profile_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `thread_routing` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`search_profile_id` text NOT NULL,
	`bound_at` numeric,
	`bound_by` text
);
--> statement-breakpoint
CREATE INDEX `idx_thread_routing_profile` ON `thread_routing` (`search_profile_id`);--> statement-breakpoint
CREATE TABLE `thread_suppression` (
	`suppression_id` text PRIMARY KEY NOT NULL,
	`thread_id` text,
	`contact_id` text,
	`dealer_id` text NOT NULL,
	`gmail_thread_id` text,
	`scope` text NOT NULL,
	`action` text NOT NULL,
	`classification` text,
	`reason` text,
	`approved_by` text DEFAULT 'pending',
	`approved_at` numeric,
	`created_at` numeric DEFAULT (CURRENT_TIMESTAMP),
	`search_profile_id` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`thread_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `dealer_contacts`(`contact_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dealer_id`) REFERENCES `dealers`(`dealer_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ck_thread_suppression_scope" CHECK(scope IN ('thread', 'contact', 'dealer')),
	CONSTRAINT "ck_thread_suppression_action" CHECK(action IN ('suppress', 'cleanup', 'unsubscribed')),
	CONSTRAINT "ck_thread_suppression_approved_by" CHECK(approved_by IN ('user', 'pending'))
);
--> statement-breakpoint
CREATE INDEX `idx_suppression_contact` ON `thread_suppression` (`contact_id`);--> statement-breakpoint
CREATE INDEX `idx_suppression_dealer` ON `thread_suppression` (`dealer_id`);--> statement-breakpoint
CREATE INDEX `idx_suppression_gmail_thread` ON `thread_suppression` (`gmail_thread_id`);--> statement-breakpoint
CREATE TABLE `threads` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`dealer_id` text NOT NULL,
	`gmail_thread_id` text,
	`channel` text DEFAULT 'email',
	`subject` text,
	`state` text DEFAULT 'replied',
	`updated_at` numeric DEFAULT (CURRENT_TIMESTAMP),
	`thread_scope` text DEFAULT 'dealer_legacy_aggregate',
	`external_thread_key` text,
	`search_profile_id` text,
	FOREIGN KEY (`dealer_id`) REFERENCES `dealers`(`dealer_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_threads_state` ON `threads` (`state`);--> statement-breakpoint
CREATE INDEX `idx_threads_dealer_id` ON `threads` (`dealer_id`);--> statement-breakpoint
CREATE TABLE `test_run_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`skill` text NOT NULL,
	`created_at` text NOT NULL,
	`layer` text NOT NULL,
	`provider` text NOT NULL,
	`model_alias` text NOT NULL,
	`cost_usd` real,
	`latency_ms` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`pricing_source` text NOT NULL,
	`price_input_per_mtok` real,
	`price_output_per_mtok` real,
	`prompt_version` text,
	`schema_version` text,
	`fail_reason` text
);
