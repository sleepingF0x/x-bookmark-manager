-- One row per bookmark ever seen. Cleaning up moves an item to the recycle bin (trashed_at) and removes it
-- from X bookmarks; restoring re-bookmarks it. Only emptying the bin deletes rows.
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  no INTEGER NOT NULL UNIQUE,          -- accession number in bookmark order, oldest = 1
  bookmarked INTEGER NOT NULL DEFAULT 1,
  pending INTEGER NOT NULL DEFAULT 0,  -- 1 = fetched from X, not yet classified/embedded
  data TEXT NOT NULL,                  -- item JSON as rendered by the site
  src TEXT,                            -- classification input for pending items
  vec TEXT,                            -- base64 int8 bge-m3 embedding
  added_at TEXT NOT NULL,
  trashed_at TEXT,                     -- in the recycle bin since (removed from X bookmarks on the way in)
  kept INTEGER NOT NULL DEFAULT 0      -- user said keep: never offered for cleanup again
);
CREATE INDEX IF NOT EXISTS items_pending ON items(pending) WHERE pending = 1;

-- Small key/value state: OAuth tokens, X user, sync bookkeeping, monthly API usage counters.
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
