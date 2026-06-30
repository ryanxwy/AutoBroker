-- Data heal (no schema change): a no-fresh-number dealer reply (a hold /
-- payment-only / come-onsite extraction) was historically persisted with a $0
-- otd_total. SQLite MIN()/nulls-last ordering rank 0 as the cheapest, so a $0 row
-- supersedes the dealer's real OTD on the board, digest, quote-compare, and
-- best-OTD surfaces. otd_total is never legitimately <= 0, so normalize every
-- such row to NULL — matching the write-side normalization in
-- replyExtract/persist.ts (a no-number reply stores null, never $0).
UPDATE dealer_quotes SET otd_total = NULL WHERE otd_total <= 0;
