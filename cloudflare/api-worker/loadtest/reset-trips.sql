-- Fast reset between load runs: clears trip data but KEEPS the account pool
-- (users/drivers/places/ride_categories). Re-run after each k6 campaign.
DELETE FROM chat_messages;
DELETE FROM ratings;
DELETE FROM notifications;
DELETE FROM wallet_tx;
DELETE FROM call_logs;
DELETE FROM trips;
UPDATE users SET walletBalance = 0, negTrips = 0, walletBlocked = 0;
