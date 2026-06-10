CREATE UNIQUE INDEX `uq_accounts_email` ON `accounts` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_dis_profile_dealer_url` ON `dealer_inventory_sources` (`search_profile_id`,`dealer_id`,`normalized_url`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_il_profile_dealer_vin` ON `inventory_listings` (`search_profile_id`,`dealer_id`,`vin`);