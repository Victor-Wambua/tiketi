/**
 * The schema. The invariant that matters most is `seat_claims`: its primary key
 * (departure_id, seat_id) means a seat can have at most one claim, whatever the application does.
 * A claim is either a hold (with an expiry) or a booking (permanent until cancelled).
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS layouts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('event','trip')),
  description TEXT NOT NULL DEFAULT '',
  venue TEXT NOT NULL,
  layout_id TEXT NOT NULL REFERENCES layouts(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS departures (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  starts_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS departure_seats (
  departure_id TEXT NOT NULL REFERENCES departures(id),
  seat_id TEXT NOT NULL,
  label TEXT NOT NULL,
  section TEXT NOT NULL,
  row_label TEXT NOT NULL,
  tier_id TEXT NOT NULL,
  price_kes INTEGER NOT NULL CHECK (price_kes >= 0),
  accessible INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (departure_id, seat_id)
);

CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY,
  departure_id TEXT NOT NULL REFERENCES departures(id),
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','expired','released','converted')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  extensions INTEGER NOT NULL DEFAULT 0,
  total_kes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS holds_active ON holds(status, expires_at);

CREATE TABLE IF NOT EXISTS hold_seats (
  hold_id TEXT NOT NULL REFERENCES holds(id),
  seat_id TEXT NOT NULL,
  price_kes INTEGER NOT NULL,
  PRIMARY KEY (hold_id, seat_id)
);

-- THE double-booking guard: at most one claim per seat per departure.
CREATE TABLE IF NOT EXISTS seat_claims (
  departure_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('hold','booked')),
  hold_id TEXT NOT NULL REFERENCES holds(id),
  expires_at INTEGER,
  PRIMARY KEY (departure_id, seat_id),
  FOREIGN KEY (departure_id, seat_id) REFERENCES departure_seats(departure_id, seat_id),
  CHECK ((kind = 'hold' AND expires_at IS NOT NULL) OR (kind = 'booked' AND expires_at IS NULL))
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  hold_id TEXT NOT NULL UNIQUE REFERENCES holds(id),
  departure_id TEXT NOT NULL REFERENCES departures(id),
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_payment','confirmed','cancelled','expired')),
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  total_kes INTEGER NOT NULL CHECK (total_kes >= 0),
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  cancelled_at INTEGER
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  provider TEXT NOT NULL,
  provider_ref TEXT UNIQUE,
  amount_kes INTEGER NOT NULL CHECK (amount_kes >= 0),
  phone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('initiating','pending','succeeded','failed','cancelled','timeout','insufficient_funds','amount_mismatch','refund_needed')),
  result_code INTEGER,
  result_desc TEXT,
  receipt TEXT,
  paid_amount_kes INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_callbacks (
  dedupe_key TEXT PRIMARY KEY,
  provider_ref TEXT NOT NULL,
  outcome TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  amount_kes INTEGER NOT NULL CHECK (amount_kes > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('needed','processed')),
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  processed_by TEXT,
  refund_ref TEXT
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  departure_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  holder_name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','void')),
  void_reason TEXT,
  void_at INTEGER,
  issued_at INTEGER NOT NULL,
  admitted_at INTEGER,
  admitted_gate TEXT,
  admitted_scan_id INTEGER
);
CREATE INDEX IF NOT EXISTS tickets_departure ON tickets(departure_id);

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT,
  departure_id TEXT,
  gate TEXT NOT NULL,
  staff_id TEXT,
  result TEXT NOT NULL,
  detail TEXT,
  client_scan_id TEXT UNIQUE,
  client_scanned_at INTEGER,
  received_at INTEGER NOT NULL,
  offline INTEGER NOT NULL DEFAULT 0,
  conflict INTEGER NOT NULL DEFAULT 0,
  prior_scan_id INTEGER
);
CREATE INDEX IF NOT EXISTS scans_ticket ON scans(ticket_id);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('organiser','gate')),
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER,
  body TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);
`;
