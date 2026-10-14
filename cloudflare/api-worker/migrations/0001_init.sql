-- LADIESGO — schema D1 (SQLite). Equivalente ao Postgres/Neon usado pelo worker.
-- Aplicar: wrangler d1 execute ladiesgo --local --file=migrations/0001_init.sql
--          wrangler d1 execute ladiesgo --remote --file=migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE,
  "passwordHash" TEXT,
  name TEXT,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'PASSENGER',
  "profilePhoto" TEXT,
  "fcmToken" TEXT,
  "isActive" INTEGER NOT NULL DEFAULT 1,
  "isVerified" INTEGER NOT NULL DEFAULT 0,
  "mustChangePassword" INTEGER NOT NULL DEFAULT 0,
  "adminCreated" INTEGER NOT NULL DEFAULT 0,
  "walletBalance" REAL NOT NULL DEFAULT 0,
  "createdAt" TEXT,
  "updatedAt" TEXT
);
CREATE INDEX IF NOT EXISTS users_phone_idx ON users(phone);

CREATE TABLE IF NOT EXISTS drivers (
  id TEXT PRIMARY KEY,
  "userId" TEXT UNIQUE,
  "licenseNumber" TEXT,
  "carPlate" TEXT,
  "carMake" TEXT,
  "carModel" TEXT,
  "carYear" INTEGER,
  "carColor" TEXT,
  "carPhoto" TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  "isOnline" INTEGER NOT NULL DEFAULT 0,
  "currentLat" REAL,
  "currentLng" REAL,
  cats TEXT,
  rating REAL DEFAULT 5,
  "totalTrips" INTEGER NOT NULL DEFAULT 0,
  "totalEarnings" REAL NOT NULL DEFAULT 0,
  "createdAt" TEXT,
  "updatedAt" TEXT
);
CREATE INDEX IF NOT EXISTS drivers_status_idx ON drivers("isOnline", status);
CREATE INDEX IF NOT EXISTS drivers_user_idx ON drivers("userId");

CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  "passengerId" TEXT,
  "driverId" TEXT,
  "pickupAddress" TEXT,
  "pickupLat" REAL,
  "pickupLng" REAL,
  "dropoffAddress" TEXT,
  "dropoffLat" REAL,
  "dropoffLng" REAL,
  status TEXT NOT NULL DEFAULT 'REQUESTED',
  "rideType" TEXT NOT NULL DEFAULT 'ECONOMY',
  "tripType" TEXT,
  "fareEstimate" REAL,
  "finalFare" REAL,
  "distanceKm" REAL,
  "paymentMethod" TEXT DEFAULT 'CASH',
  "paymentStatus" TEXT,
  "promoCodeId" TEXT,
  "packageDescription" TEXT,
  "receiverName" TEXT,
  "receiverPhone" TEXT,
  stops TEXT,
  "scheduledAt" TEXT,
  "cancelledBy" TEXT,
  "cancelReason" TEXT,
  "viewedBy" TEXT,
  "createdAt" TEXT,
  "updatedAt" TEXT,
  "acceptedAt" TEXT,
  "arrivedAt" TEXT,
  "startedAt" TEXT,
  "completedAt" TEXT,
  "offerQueue" TEXT,
  "offerIdx" INTEGER NOT NULL DEFAULT 0,
  "offeredDriverId" TEXT,
  "offeredAt" TEXT,
  "offerExpiresAt" TEXT,
  "offerBroadcast" INTEGER NOT NULL DEFAULT 0,
  "offerSkipped" TEXT,
  "offerMissed" TEXT
);
CREATE INDEX IF NOT EXISTS trips_passenger_idx ON trips("passengerId", status);
CREATE INDEX IF NOT EXISTS trips_driver_idx ON trips("driverId", status);
CREATE INDEX IF NOT EXISTS trips_status_idx ON trips(status, "createdAt");

CREATE TABLE IF NOT EXISTS ratings (
  id TEXT PRIMARY KEY,
  "tripId" TEXT NOT NULL,
  "raterId" TEXT NOT NULL,
  "ratedId" TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 5,
  comment TEXT NOT NULL DEFAULT '',
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ratings_trip_rater ON ratings("tripId", "raterId");

CREATE TABLE IF NOT EXISTS ride_categories (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#61188E',
  mult REAL NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS call_logs (
  id TEXT PRIMARY KEY,
  "tripId" TEXT,
  "userId" TEXT,
  "durationSec" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS call_logs_created_idx ON call_logs("createdAt");

CREATE TABLE IF NOT EXISTS call_signals (
  id TEXT PRIMARY KEY,
  "tripId" TEXT,
  "senderId" TEXT,
  type TEXT,
  payload TEXT,
  "createdAt" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS call_signals_trip_idx ON call_signals("tripId", "createdAt");

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  "tripId" TEXT,
  "senderId" TEXT,
  "senderName" TEXT,
  text TEXT,
  "createdAt" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS chat_messages_trip_idx ON chat_messages("tripId", "createdAt");

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  "userId" TEXT,
  title TEXT,
  body TEXT,
  type TEXT,
  "isRead" INTEGER NOT NULL DEFAULT 0,
  data TEXT,
  "createdAt" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications("userId", "createdAt");

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  "reporterId" TEXT,
  "reportedUserId" TEXT,
  reason TEXT,
  "tripId" TEXT,
  "createdAt" TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO ride_categories (code, name, color, mult, sort) VALUES
  ('ECONOMY','Económico','#61188E',1.0,1),
  ('COMFORT','Conforto','#ff5fc8',1.4,2),
  ('PREMIUM','Família','#5b21c9',1.65,3);
