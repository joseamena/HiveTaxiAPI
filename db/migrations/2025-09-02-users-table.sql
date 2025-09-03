-- Rename drivers table to users
ALTER TABLE drivers RENAME TO users;

-- Add type field to distinguish driver/rider
ALTER TABLE users ADD COLUMN type VARCHAR(16) NOT NULL DEFAULT 'driver';

-- Example: Update existing drivers to type 'driver'
UPDATE users SET type = 'driver';

-- You can now insert riders with type 'rider'
-- Example insert for a rider:
-- INSERT INTO users (username, email, password_hash, phone_number, type) VALUES ('rider1', 'rider1@example.com', '<hash>', '1234567890', 'rider');
