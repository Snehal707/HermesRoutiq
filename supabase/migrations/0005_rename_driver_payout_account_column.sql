ALTER TABLE drivers
ADD COLUMN IF NOT EXISTS stripe_payout_account_id TEXT;

UPDATE drivers
SET stripe_payout_account_id = COALESCE(stripe_payout_account_id, stripe_connected_account_id)
WHERE stripe_connected_account_id IS NOT NULL;

ALTER TABLE drivers
DROP COLUMN IF EXISTS stripe_connected_account_id;
