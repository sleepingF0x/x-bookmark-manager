-- Recycle bin + user "keep" override (for databases created before these columns existed).
-- Items already off the X bookmark list start in the bin.
ALTER TABLE items ADD COLUMN trashed_at TEXT;
ALTER TABLE items ADD COLUMN kept INTEGER NOT NULL DEFAULT 0;
UPDATE items SET trashed_at = datetime('now') WHERE bookmarked = 0;
