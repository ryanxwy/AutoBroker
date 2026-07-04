/**
 * AutoBroker product schema — drizzle-kit pull baseline + manual corrections.
 *
 * PROVENANCE: introspected from the COLD-COPIED legacy SQLite
 * (~/.autobroker-ts/autobroker.db, produced by
 * ../../scripts/cold-copy-sqlite.sh — copy-not-share, never two-way sync).
 * All 23 legacy Alembic revisions are discarded; the introspected DB is the
 * single source of truth. `alembic_version` is excluded declaratively via
 * drizzle.config.ts tablesFilter.
 *
 * MANUAL CORRECTIONS re-applied after every `db:pull` (verified against
 * drizzle-kit 0.31.x behaviour on 2026-06-03 — KEEP THIS LIST CURRENT):
 *
 *   1. FOUR partial indexes — introspection DROPS the WHERE predicate:
 *        - uq_search_profiles_active_account_brand  WHERE status = 'active'
 *        - idx_message_analysis_current             WHERE is_current = 1
 *        - idx_il_url_fallback                      WHERE vin IS NULL
 *        - uq_profile_dealers_bound_dealer          WHERE status = 'bound'
 *          (dealership-exclusivity backstop: at most ONE profile may hold a
 *          given dealer_id as status='bound' across all profiles)
 *
 *   2. CHECK constraints — introspection is UNUSABLE for CHECKs on this
 *      schema: it misattributes every CHECK to every table (26×12) and
 *      truncates trailing parens (`IN (0, 1` ← broken). Strip ALL pulled
 *      check() entries and re-author the 13 real ones from the oracle DDL
 *      (sqlite_master) on the 8 true CHECK tables: message_analysis (4),
 *      message_questions (1), thread_suppression (3), session_turns (1),
 *      messages (1), dealers (1), lead_submissions (1 — ck_lead_submissions_xor,
 *      the keystone irreversible-scope invariant: a row is reached via EXACTLY
 *      ONE of {web-form submit, email send}; email_fallback_reason gated),
 *      profile_dealers (1 — ck_profile_dealers_status, the bind-status enum:
 *      status IN candidate/bound/excluded_conflict/closed_out). NOTE: this is
 *      a TS-authored CHECK with NO legacy oracle origin (the dealership-
 *      exclusivity feature is new in the TS rebuild), so it will NOT round-trip
 *      from a future db:pull of the frozen oracle — re-author it after a pull.
 *
 *   3. FK actions — the oracle declares NO ON DELETE / ON UPDATE anywhere, so
 *      the pulled FKs (18) are faithful as-is; nothing to re-add today. If a
 *      future pull shows fewer than 18 foreignKey()s, investigate.
 *
 * The CI empty-diff gate (package.json db:check) diffs `drizzle-kit generate`
 * output against the committed drizzle/ snapshot, which was generated FROM
 * this corrected file — so the gate verifies THIS file, not the raw pull.
 *
 * IMPORT RULE: this package is the ONLY layer (with packages/tools delegating
 * here) permitted to touch SQLite. core/ must never import drizzle.
 * (The five-layer one-way dependency rule — see CLAUDE.md.)
 */

import { sqliteTable, uniqueIndex, check, text, integer, real, numeric, index, primaryKey } from "drizzle-orm/sqlite-core"
  import { sql } from "drizzle-orm"

export const searchProfiles = sqliteTable("search_profiles", {
	searchProfileId: text("search_profile_id").primaryKey(),
	year: integer().notNull(),
	make: text().notNull(),
	model: text().notNull(),
	trim: text(),
	budgetMax: real("budget_max"),
	searchRadiusMiles: integer("search_radius_miles").default(25),
	locationQuery: text("location_query"),
	resolvedAddress: text("resolved_address"),
	city: text(),
	state: text(),
	postalCode: text("postal_code"),
	country: text().default("US"),
	latitude: real(),
	longitude: real(),
	followUpEmail: text("follow_up_email"),
	followUpPhone: text("follow_up_phone"),
	phonePolicy: text("phone_policy").default("fake"),
	fakePhone: text("fake_phone"),
	financingPreference: text("financing_preference"),
	tradeInDescription: text("trade_in_description"),
	militaryFirstResponder: integer("military_first_responder").default(0),
	currentBrandOwner: integer("current_brand_owner").default(0),
	preferredExteriorColorsJson: text("preferred_exterior_colors_json"),
	preferredInteriorColorsJson: text("preferred_interior_colors_json"),
	acceptableTrimsJson: text("acceptable_trims_json"),
	featurePreferencesJson: text("feature_preferences_json"),
	accountId: text("account_id"),
	brand: text(),
	location: text(),
	status: text(),
	supersededBy: text("superseded_by"),
	updatedAt: numeric("updated_at"),
},
(table) => [
	uniqueIndex("uq_search_profiles_active_account_brand").on(table.accountId, table.brand).where(sql`status = 'active'`),
]);

export const threads = sqliteTable("threads", {
	threadId: text("thread_id").primaryKey(),
	dealerId: text("dealer_id").notNull().references(() => dealers.dealerId),
	gmailThreadId: text("gmail_thread_id"),
	channel: text().default("email"),
	subject: text(),
	state: text().default("replied"),
	updatedAt: numeric("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	threadScope: text("thread_scope").default("dealer_legacy_aggregate"),
	externalThreadKey: text("external_thread_key"),
	searchProfileId: text("search_profile_id"),
},
(table) => [
	index("idx_threads_state").on(table.state),
	index("idx_threads_dealer_id").on(table.dealerId),
]);

export const offers = sqliteTable("offers", {
	offerId: text("offer_id").primaryKey(),
	threadId: text("thread_id").notNull().references(() => threads.threadId),
	dealerId: text("dealer_id").notNull().references(() => dealers.dealerId),
	messageId: text("message_id").references(() => messages.messageId),
	vin: text(),
	sellingPrice: real("selling_price"),
	otdEstimate: real("otd_estimate"),
	msrp: real(),
	feesJson: text("fees_json"),
	addOnsJson: text("add_ons_json"),
	inventoryStatus: text("inventory_status"),
	confidence: real(),
	vsMarketJson: text("vs_market_json"),
	sourceSnippet: text("source_snippet"),
	verificationNotes: text("verification_notes"),
	searchProfileId: text("search_profile_id"),
},
(table) => [
	index("idx_offers_dealer_id").on(table.dealerId),
]);

export const pipelineState = sqliteTable("pipeline_state", {
	key: text().primaryKey(),
	value: text(),
	updatedAt: numeric("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	searchProfileId: text("search_profile_id"),
});

export const dealerContacts = sqliteTable("dealer_contacts", {
	contactId: text("contact_id").primaryKey(),
	dealerId: text("dealer_id").notNull().references(() => dealers.dealerId),
	email: text(),
	displayName: text("display_name"),
	normalizedEmail: text("normalized_email").notNull(),
	role: text(),
	roleConfidence: real("role_confidence"),
	seniorityRank: integer("seniority_rank"),
	phone: text(),
	firstSeenAt: numeric("first_seen_at"),
	lastSeenAt: numeric("last_seen_at"),
	isPrimaryReplyTarget: integer("is_primary_reply_target").default(0),
	source: text(),
	preferredScore: integer("preferred_score").default(0),
	scoreReason: text("score_reason"),
	isCrmPlatformSender: integer("is_crm_platform_sender").default(0),
	searchProfileId: text("search_profile_id"),
},
(table) => [
	uniqueIndex("idx_dealer_contacts_lookup").on(table.dealerId, table.normalizedEmail),
]);

export const messageAnalysis = sqliteTable("message_analysis", {
	analysisId: text("analysis_id").primaryKey(),
	messageId: text("message_id").notNull().references(() => messages.messageId),
	contactId: text("contact_id").references(() => dealerContacts.contactId),
	analysisVersion: integer("analysis_version").default(1).notNull(),
	isCurrent: integer("is_current").default(1).notNull(),
	intent: text(),
	summaryShort: text("summary_short"),
	summaryBulletsJson: text("summary_bullets_json"),
	quoteSignal: text("quote_signal"),
	needsResponse: integer("needs_response").default(0),
	replyPriority: integer("reply_priority").default(3),
	promisedFollowUpAt: numeric("promised_follow_up_at"),
	confidence: real(),
	rawExtractJson: text("raw_extract_json"),
	searchProfileId: text("search_profile_id"),
},
(table) => [
	check("ck_message_analysis_version", sql`analysis_version >= 1`),
	check("ck_message_analysis_is_current_bool", sql`is_current IN (0, 1)`),
	check("ck_message_analysis_needs_response_bool", sql`needs_response IN (0, 1)`),
	check("ck_message_analysis_reply_priority_range", sql`reply_priority BETWEEN 1 AND 5`),
	index("idx_message_analysis_contact_current").on(table.contactId, table.isCurrent),
	uniqueIndex("idx_message_analysis_current").on(table.messageId).where(sql`is_current = 1`),
	uniqueIndex("idx_message_analysis_message_version").on(table.messageId, table.analysisVersion),
]);

export const messageQuestions = sqliteTable("message_questions", {
	questionId: text("question_id").primaryKey(),
	analysisId: text("analysis_id").notNull().references(() => messageAnalysis.analysisId),
	questionType: text("question_type").notNull(),
	questionText: text("question_text").notNull(),
	status: text().default("needs_user_input").notNull(),
	searchProfileId: text("search_profile_id"),
},
(table) => [
	check("ck_message_questions_status", sql`status IN ('answerable_from_profile', 'needs_user_input', 'informational_only')`),
	index("idx_message_questions_status").on(table.status, table.analysisId),
	index("idx_message_questions_analysis_id").on(table.analysisId),
]);

export const messageClaims = sqliteTable("message_claims", {
	claimId: text("claim_id").primaryKey(),
	analysisId: text("analysis_id").notNull().references(() => messageAnalysis.analysisId),
	claimType: text("claim_type").notNull(),
	claimText: text("claim_text").notNull(),
	confidence: real(),
	searchProfileId: text("search_profile_id"),
},
(table) => [
	index("idx_message_claims_analysis_id").on(table.analysisId),
]);

export const threadSuppression = sqliteTable("thread_suppression", {
	suppressionId: text("suppression_id").primaryKey(),
	threadId: text("thread_id").references(() => threads.threadId),
	contactId: text("contact_id").references(() => dealerContacts.contactId),
	dealerId: text("dealer_id").notNull().references(() => dealers.dealerId),
	gmailThreadId: text("gmail_thread_id"),
	scope: text().notNull(),
	action: text().notNull(),
	classification: text(),
	reason: text(),
	approvedBy: text("approved_by").default("pending"),
	approvedAt: numeric("approved_at"),
	createdAt: numeric("created_at").default(sql`(CURRENT_TIMESTAMP)`),
	searchProfileId: text("search_profile_id"),
},
(table) => [
	check("ck_thread_suppression_scope", sql`scope IN ('thread', 'contact', 'dealer')`),
	check("ck_thread_suppression_action", sql`action IN ('suppress', 'cleanup', 'unsubscribed')`),
	check("ck_thread_suppression_approved_by", sql`approved_by IN ('user', 'pending')`),
	index("idx_suppression_contact").on(table.contactId),
	index("idx_suppression_dealer").on(table.dealerId),
	index("idx_suppression_gmail_thread").on(table.gmailThreadId),
]);

export const accounts = sqliteTable("accounts", {
	accountId: text("account_id").primaryKey().notNull(),
	email: text().notNull(),
	oauthRef: text("oauth_ref"),
	createdAt: numeric("created_at").default(sql`(CURRENT_TIMESTAMP)`),
},
(table) => [
	// Restored manually: drizzle-kit pull drops table-level UNIQUE constraints
	// (they materialize as implicit sqlite_autoindex_* rows whose sql is NULL).
	uniqueIndex("uq_accounts_email").on(table.email),
]);

export const threadRouting = sqliteTable("thread_routing", {
	threadId: text("thread_id").primaryKey().notNull(),
	searchProfileId: text("search_profile_id").notNull(),
	boundAt: numeric("bound_at"),
	boundBy: text("bound_by"),
},
(table) => [
	index("idx_thread_routing_profile").on(table.searchProfileId),
]);

export const profileDealers = sqliteTable("profile_dealers", {
	searchProfileId: text("search_profile_id").notNull(),
	dealerId: text("dealer_id").notNull(),
	status: text().default("candidate").notNull(),
	boundAt: numeric("bound_at").default(sql`(CURRENT_TIMESTAMP)`),
	exclusionReason: text("exclusion_reason"),
},
(table) => [
	index("idx_profile_dealers_dealer").on(table.dealerId),
	uniqueIndex("uq_profile_dealers_bound_dealer").on(table.dealerId).where(sql`status = 'bound'`),
	check("ck_profile_dealers_status", sql`status IN ('candidate', 'bound', 'excluded_conflict', 'closed_out')`),
	primaryKey({ columns: [table.searchProfileId, table.dealerId], name: "profile_dealers_search_profile_id_dealer_id_pk"})
]);

export const auditLog = sqliteTable("audit_log", {
	auditId: text("audit_id").primaryKey().notNull(),
	at: numeric().default(sql`(CURRENT_TIMESTAMP)`).notNull(),
	actor: text(),
	action: text().notNull(),
	targetTable: text("target_table"),
	targetId: text("target_id"),
	searchProfileId: text("search_profile_id"),
	field: text(),
	oldValue: text("old_value"),
	newValue: text("new_value"),
	reason: text(),
	payloadJson: text("payload_json"),
},
(table) => [
	index("idx_audit_log_target").on(table.targetTable, table.targetId),
	index("idx_audit_log_at").on(table.at),
]);

export const sessionTurns = sqliteTable("session_turns", {
	id: text().primaryKey().notNull(),
	sessionId: text("session_id").notNull().references(() => sessions.id),
	kind: text().notNull(),
	text: text().notNull(),
	createdAt: text("created_at").notNull(),
},
(table) => [
	check("ck_session_turns_kind", sql`kind IN ('user')`),
	index("idx_session_turns_session").on(table.sessionId, table.createdAt),
]);

export const sessions = sqliteTable("sessions", {
	id: text().primaryKey().notNull(),
	title: text().notNull(),
	createdAt: text("created_at").notNull(),
	lastActivityAt: text("last_activity_at").notNull(),
	pinnedProfileId: text("pinned_profile_id").references(() => searchProfiles.searchProfileId),
	archived: integer().default(0).notNull(),
	provider: text().default("anthropic").notNull(),
	authMode: text("auth_mode").default("oauth").notNull(),
	driverKind: text("driver_kind").default("agent").notNull(),
	model: text().default("default").notNull(),
},
(table) => [
	index("idx_sessions_last_activity").on(table.lastActivityAt),
	index("idx_sessions_archived").on(table.archived),
]);

export const dealerQuotes = sqliteTable("dealer_quotes", {
	quoteId: text("quote_id").primaryKey().notNull(),
	dealerId: text("dealer_id").notNull(),
	messageId: text("message_id").notNull(),
	sourceGmailMessageId: text("source_gmail_message_id").notNull(),
	searchProfileId: text("search_profile_id").notNull(),
	vin: text(),
	inventoryStatus: text("inventory_status"),
	msrp: real(),
	sellingPrice: real("selling_price"),
	dealerDiscount: real("dealer_discount"),
	rebatesJson: text("rebates_json"),
	docFee: real("doc_fee"),
	dealerFee: real("dealer_fee"),
	salesTax: real("sales_tax"),
	dmvFees: real("dmv_fees"),
	titleFee: real("title_fee"),
	registrationFee: real("registration_fee"),
	licenseFee: real("license_fee"),
	otherFeesJson: text("other_fees_json"),
	addOnsJson: text("add_ons_json"),
	taxableRebatesJson: text("taxable_rebates_json"),
	otdTotal: real("otd_total"),
	quoteFormat: text("quote_format"),
	intent: text(),
	confidence: real(),
	rawSourceBlob: text("raw_source_blob"),
	quoteReceivedAt: numeric("quote_received_at"),
	quoteExpiresAt: numeric("quote_expires_at"),
	extractedAt: numeric("extracted_at"),
	extractorProvider: text("extractor_provider"),
	extractionMethod: text("extraction_method"),
	financingMode: text("financing_mode").notNull(),
	financeApr: real("finance_apr"),
	financeTermMonths: integer("finance_term_months"),
	financeDownPayment: real("finance_down_payment"),
	financeMonthlyPayment: real("finance_monthly_payment"),
	financeAmountFinanced: real("finance_amount_financed"),
	leaseTermMonths: integer("lease_term_months"),
	leaseMoneyFactor: real("lease_money_factor"),
	leaseResidualPct: real("lease_residual_pct"),
	leaseResidualValue: real("lease_residual_value"),
	leaseDueAtSigning: real("lease_due_at_signing"),
	leaseMonthlyPayment: real("lease_monthly_payment"),
	leaseMilesPerYear: integer("lease_miles_per_year"),
	leaseAcquisitionFee: real("lease_acquisition_fee"),
	leaseDispositionFee: real("lease_disposition_fee"),
	leaseCapCostGross: real("lease_cap_cost_gross"),
	leaseCapCostAdjusted: real("lease_cap_cost_adjusted"),
	leaseRentCharge: real("lease_rent_charge"),
	sourceListingId: text("source_listing_id"),
},
(table) => [
	index("idx_dealer_quotes_dealer_profile").on(table.dealerId, table.searchProfileId),
	index("idx_dealer_quotes_profile_received").on(table.searchProfileId, table.quoteReceivedAt),
	uniqueIndex("idx_dealer_quotes_source_msg").on(table.sourceGmailMessageId, table.financingMode),
]);

export const messages = sqliteTable("messages", {
	messageId: text("message_id").primaryKey(),
	threadId: text("thread_id").references(() => threads.threadId),
	gmailMessageId: text("gmail_message_id"),
	rfcMessageId: text("rfc_message_id"),
	direction: text().notNull(),
	sender: text(),
	recipient: text(),
	subject: text(),
	bodyText: text("body_text"),
	receivedAt: numeric("received_at"),
	processedAt: numeric("processed_at"),
	keyInfoJson: text("key_info_json"),
	contactId: text("contact_id"),
	senderEmail: text("sender_email"),
	senderName: text("sender_name"),
	searchProfileId: text("search_profile_id"),
	quoteExtractionStatus: text("quote_extraction_status").default("pending"),
	quoteExtractionIntent: text("quote_extraction_intent"),
},
(table) => [
	check("ck_messages_quote_extraction_status_intent", sql`(quote_extraction_status = 'pending' AND quote_extraction_intent IS NULL) OR (quote_extraction_status = 'succeeded' AND quote_extraction_intent IS NOT NULL) OR (quote_extraction_status = 'failed' AND quote_extraction_intent IS NULL)`),
	index("idx_messages_sender_email").on(table.senderEmail),
	index("idx_messages_contact_id").on(table.contactId),
	index("idx_messages_thread_id").on(table.threadId),
]);

export const manufacturerIncentives = sqliteTable("manufacturer_incentives", {
	id: integer().primaryKey().notNull(),
	make: text().notNull(),
	model: text().notNull(),
	zip: text().notNull(),
	type: text().notNull(),
	amount: real().notNull(),
	expires: numeric(),
	eligibility: text().notNull(),
	scrapedAt: numeric("scraped_at").notNull(),
	scrapeSourceUrl: text("scrape_source_url").notNull(),
},
(table) => [
	index("idx_mfr_incentives_lookup").on(table.make, table.model, table.zip, table.expires),
]);

export const quoteAudits = sqliteTable("quote_audits", {
	auditId: integer("audit_id").primaryKey().notNull(),
	dealerQuoteId: text("dealer_quote_id").notNull().references(() => dealerQuotes.quoteId),
	searchProfileId: text("search_profile_id").notNull(),
	flagsJson: text("flags_json").notNull(),
	auditedAt: numeric("audited_at").notNull(),
	auditPassVersion: text("audit_pass_version").notNull(),
},
(table) => [
	index("idx_quote_audits_profile_audited").on(table.searchProfileId, table.auditedAt),
	uniqueIndex("idx_quote_audits_quote_pass").on(table.dealerQuoteId, table.auditPassVersion),
]);

export const skillRuns = sqliteTable("skill_runs", {
	runId: text("run_id").primaryKey().notNull(),
	skillName: text("skill_name").notNull(),
	searchProfileId: text("search_profile_id"),
	startedAt: numeric("started_at").notNull(),
	finishedAt: numeric("finished_at"),
	status: text().notNull(),
	inputJson: text("input_json"),
	summaryText: text("summary_text"),
	transcriptJson: text("transcript_json"),
	sessionId: text("session_id"),
	idempotencyKey: text("idempotency_key"),
	transportState: text("transport_state").default("connected"),
	lastHeartbeatAt: numeric("last_heartbeat_at"),
	dispatchedSkillName: text("dispatched_skill_name"),
},
(table) => [
	uniqueIndex("idx_skill_runs_idempotency_key").on(table.idempotencyKey),
	index("idx_skill_runs_session").on(table.sessionId, table.startedAt),
	index("idx_skill_runs_profile_started").on(table.searchProfileId, table.startedAt),
]);

export const dealerInventorySources = sqliteTable("dealer_inventory_sources", {
	sourceId: text("source_id").primaryKey().notNull(),
	searchProfileId: text("search_profile_id").notNull(),
	dealerId: text("dealer_id").notNull(),
	sourceType: text("source_type").notNull(),
	sourceUrl: text("source_url").notNull(),
	normalizedUrl: text("normalized_url").notNull(),
	discoveryMethod: text("discovery_method").notNull(),
	parentSourceId: text("parent_source_id"),
	firstSeenAt: numeric("first_seen_at").notNull(),
	lastScannedAt: numeric("last_scanned_at"),
	lastStatus: text("last_status").notNull(),
	blockedCount: integer("blocked_count").default(0).notNull(),
	errorJson: text("error_json"),
},
(table) => [
	// Restored manually (introspection drops table-level UNIQUE): the source
	// idempotency key — scan upserts and the site_scan↔link_scan reconciliation
	// both key on (profile, dealer, normalized_url).
	uniqueIndex("uq_dis_profile_dealer_url").on(table.searchProfileId, table.dealerId, table.normalizedUrl),
	index("idx_dis_status").on(table.lastStatus),
	index("idx_dis_profile_dealer").on(table.searchProfileId, table.dealerId),
]);

export const inventoryListings = sqliteTable("inventory_listings", {
	listingId: text("listing_id").primaryKey().notNull(),
	searchProfileId: text("search_profile_id").notNull(),
	dealerId: text("dealer_id").notNull(),
	sourceId: text("source_id"),
	vin: text(),
	stockNumber: text("stock_number"),
	year: integer(),
	make: text(),
	model: text(),
	trim: text(),
	exteriorColor: text("exterior_color"),
	interiorColor: text("interior_color"),
	drivetrain: text(),
	powertrain: text(),
	featureText: text("feature_text"),
	packagesJson: text("packages_json"),
	msrp: real(),
	listedPrice: real("listed_price"),
	dealerDiscount: real("dealer_discount"),
	dealerMarkup: real("dealer_markup"),
	pricingBreakdownJson: text("pricing_breakdown_json"),
	incentivesText: text("incentives_text"),
	inventoryStatus: text("inventory_status").notNull(),
	listingUrl: text("listing_url"),
	normalizedListingUrl: text("normalized_listing_url"),
	matchStatus: text("match_status").notNull(),
	rawListingJson: text("raw_listing_json").notNull(),
	firstSeenAt: numeric("first_seen_at").notNull(),
	lastSeenAt: numeric("last_seen_at").notNull(),
	observedAt: numeric("observed_at").notNull(),
	supersededAt: numeric("superseded_at"),
	supersededReason: text("superseded_reason"),
},
(table) => [
	// Restored manually (introspection drops table-level UNIQUE). Non-partial on
	// nullable vin — SQLite NULLs are distinct, so this key dedupes VIN-bearing
	// rows ONLY; NULL-VIN dedupe is delegated entirely to the partial
	// idx_il_url_fallback below. Upserts must branch their ON CONFLICT target on
	// VIN presence.
	uniqueIndex("uq_il_profile_dealer_vin").on(table.searchProfileId, table.dealerId, table.vin),
	uniqueIndex("idx_il_url_fallback").on(table.searchProfileId, table.dealerId, table.normalizedListingUrl).where(sql`vin IS NULL`),
	index("idx_il_freshness").on(table.lastSeenAt),
	index("idx_il_dealer").on(table.dealerId),
	index("idx_il_profile_match").on(table.searchProfileId, table.matchStatus),
	index("idx_il_profile").on(table.searchProfileId),
]);

export const dealers = sqliteTable("dealers", {
	dealerId: text("dealer_id").primaryKey(),
	name: text().notNull(),
	address: text(),
	city: text(),
	state: text(),
	postalCode: text("postal_code"),
	phone: text(),
	website: text(),
	contactEmail: text("contact_email"),
	googlePlaceId: text("google_place_id"),
	latitude: real(),
	longitude: real(),
	distanceMiles: real("distance_miles"),
	rating: real(),
	reviewCount: integer("review_count"),
	country: text().default("US").notNull(),
},
(table) => [
	check("ck_dealers_country", sql`country IN ('US', 'CA', 'MX')`),
	index("idx_dealers_country").on(table.country),
	uniqueIndex("idx_dealers_place_id").on(table.googlePlaceId),
]);

export const leadSubmissions = sqliteTable("lead_submissions", {
	submissionId: text("submission_id").primaryKey(),
	dealerId: text("dealer_id").notNull().references(() => dealers.dealerId),
	formUrl: text("form_url"),
	submittedEmail: text("submitted_email"),
	commentText: text("comment_text"),
	screenshotPath: text("screenshot_path"),
	searchProfileId: text("search_profile_id"),
	sourceListingId: text("source_listing_id"),
	submittedAt: numeric("submitted_at"),
	outcome: text().default("pending").notNull(),
	submissionChannel: text("submission_channel"),
	failReason: text("fail_reason"),
	emailFallbackReason: text("email_fallback_reason"),
},
() => [
	check("ck_lead_submissions_xor", sql`(outcome = 'pending' AND submission_channel IS NULL AND fail_reason IS NULL AND email_fallback_reason IS NULL) OR (outcome = 'submitted' AND submission_channel IS NOT NULL AND submission_channel IN ('web_form','email') AND fail_reason IS NULL AND ((submission_channel = 'email' AND email_fallback_reason IS NOT NULL AND email_fallback_reason IN ('no_form','captcha_fallback','user_override')) OR (submission_channel = 'web_form' AND email_fallback_reason IS NULL))) OR (outcome = 'failed' AND submission_channel IS NULL AND email_fallback_reason IS NULL AND fail_reason IS NOT NULL AND fail_reason IN ('captcha_blocked','form_not_found','site_unreachable','form_rejected','user_skipped','unknown'))`),
]);

export const decisions = sqliteTable("decisions", {
	runId: text("run_id").notNull(),
	decisionId: text("decision_id").notNull(),
	formKind: text("form_kind").notNull(),
	specPath: text("spec_path").notNull(),
	specInline: text("spec_inline").notNull(),
	clientId: text("client_id"),
	createdAt: numeric("created_at").default(sql`(CURRENT_TIMESTAMP)`).notNull(),
	consumedAt: numeric("consumed_at"),
},
(table) => [
	index("ix_decisions_run_id_consumed_at").on(table.runId, table.consumedAt),
	primaryKey({ columns: [table.runId, table.decisionId], name: "decisions_run_id_decision_id_pk"})
]);

export const messageAttachments = sqliteTable("message_attachments", {
	attachmentId: text("attachment_id").primaryKey().notNull(),
	messageId: text("message_id").notNull().references(() => messages.messageId),
	filename: text().notNull(),
	mimeType: text("mime_type").notNull(),
	size: integer().notNull(),
	storagePath: text("storage_path").notNull(),
	sha256: text(),
	createdAt: numeric("created_at").default(sql`(CURRENT_TIMESTAMP)`),
	fetchedAt: numeric("fetched_at"),
	isOrphaned: numeric("is_orphaned").notNull(),
},
(table) => [
	index("idx_message_attachments_message_id").on(table.messageId),
]);

// ── Fake mailbox sandbox (TS-owned; no legacy/oracle equivalent) ─────────────
// These four tables are the deterministic, local-only Gmail backend that the
// FakeGmailAdapter reads and writes. They are a SEPARATE sandbox from the
// PRODUCT email tables (threads / messages / message_attachments) and never
// hold real-mailbox rows. The product extractor keeps using message_attachments
// for real attachment provenance; the fake adapter stores its own bytes in
// fake_mailbox_attachments keyed to fake_mailbox_messages.

export const fakeMailboxThreads = sqliteTable("fake_mailbox_threads", {
	threadId: text("thread_id").primaryKey().notNull(),
	subject: text(),
	searchProfileId: text("search_profile_id"),
},
(table) => [
	index("idx_fake_mailbox_threads_profile").on(table.searchProfileId),
]);

export const fakeMailboxMessages = sqliteTable("fake_mailbox_messages", {
	messageId: text("message_id").primaryKey().notNull(),
	threadId: text("thread_id").notNull().references(() => fakeMailboxThreads.threadId),
	// The base64url RFC-2822 raw — the byte-identical seam shared with a real send.
	raw: text().notNull(),
	to: text().notNull(),
	from: text().notNull(),
	subject: text(),
	// Monotonic epoch-ms receive timestamp — the strictly-increasing ordering key
	// the adapter's getCurrentHistoryId() and the sync watermark trust.
	internalDateMs: integer("internal_date_ms").notNull(),
	direction: text().notNull(),
	// 1 when the (outbound) message is "delivered" into the sandbox, 0 otherwise.
	isDelivered: integer("is_delivered").default(1).notNull(),
	searchProfileId: text("search_profile_id"),
},
(table) => [
	check("ck_fake_mailbox_messages_direction", sql`direction IN ('inbound', 'outbound')`),
	check("ck_fake_mailbox_messages_is_delivered_bool", sql`is_delivered IN (0, 1)`),
	index("idx_fake_mailbox_messages_thread").on(table.threadId),
	index("idx_fake_mailbox_messages_internal_date").on(table.internalDateMs),
	index("idx_fake_mailbox_messages_profile").on(table.searchProfileId),
]);

export const fakeMailboxAttachments = sqliteTable("fake_mailbox_attachments", {
	attachmentId: text("attachment_id").primaryKey().notNull(),
	messageId: text("message_id").notNull().references(() => fakeMailboxMessages.messageId),
	filename: text().notNull(),
	mimeType: text("mime_type").notNull(),
	size: integer().notNull(),
	// The attachment's decoded bytes as a base64 string (JSON-as-text, no BLOB):
	// the fake side fetches these back through downloadAttachment().
	dataBase64: text("data_base64").notNull(),
},
(table) => [
	index("idx_fake_mailbox_attachments_message").on(table.messageId),
]);

export const sandboxState = sqliteTable("sandbox_state", {
	key: text().primaryKey().notNull(),
	value: text(),
	updatedAt: numeric("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
});

