ALTER TABLE drivers
ADD COLUMN IF NOT EXISTS stripe_connected_account_id TEXT;

ALTER TABLE ledger
ADD COLUMN IF NOT EXISTS stripe_reference TEXT;
