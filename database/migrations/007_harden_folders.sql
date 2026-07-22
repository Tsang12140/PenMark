-- Repair folders tables created by early deployments.
--
-- Earlier releases could leave an existing folders table without user_id,
-- sort_order, or created_at. 001_initial.sql deliberately uses CREATE TABLE
-- IF NOT EXISTS, so it could not correct that old shape. New folder inserts
-- would therefore fail forever. This migration is additive and also repairs
-- a stale serial sequence after a manual import or restore.

ALTER TABLE folders ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE folders ADD COLUMN IF NOT EXISTS sort_order INTEGER;
ALTER TABLE folders ADD COLUMN IF NOT EXISTS created_at BIGINT;

UPDATE folders
SET sort_order = 0
WHERE sort_order IS NULL;

UPDATE folders
SET created_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
WHERE created_at IS NULL;

-- First recover ownership from documents already assigned to a folder.
UPDATE folders AS folder
SET user_id = owner.user_id
FROM (
  SELECT folder_id, MIN(user_id) AS user_id
  FROM documents
  WHERE folder_id IS NOT NULL AND user_id IS NOT NULL
  GROUP BY folder_id
  HAVING COUNT(DISTINCT user_id) = 1
) AS owner
WHERE folder.id = owner.folder_id
  AND folder.user_id IS NULL;

-- An empty legacy folder has no document from which to infer ownership. Those
-- folders predate per-user isolation, so give remaining records to the oldest
-- administrator, which preserves the original deployment owner's access.
DO $$
DECLARE
  legacy_owner_id INTEGER;
BEGIN
  SELECT id INTO legacy_owner_id
  FROM users
  WHERE is_admin = 1
  ORDER BY id ASC
  LIMIT 1;

  IF legacy_owner_id IS NOT NULL THEN
    UPDATE folders SET user_id = legacy_owner_id WHERE user_id IS NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM folders WHERE user_id IS NULL) THEN
    RAISE EXCEPTION
      'folders contains legacy records with no safe owner; create an administrator or populate user_id before restarting PenMark';
  END IF;
END $$;

ALTER TABLE folders ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE folders ALTER COLUMN sort_order SET DEFAULT 0;
ALTER TABLE folders ALTER COLUMN sort_order SET NOT NULL;
ALTER TABLE folders ALTER COLUMN created_at SET NOT NULL;

-- A manual import can leave folders_id_seq behind MAX(id), making every new
-- folder collide with an existing primary key.
SELECT setval(
  pg_get_serial_sequence('folders', 'id'),
  COALESCE((SELECT MAX(id) FROM folders), 1),
  (SELECT COUNT(*) > 0 FROM folders)
)
WHERE pg_get_serial_sequence('folders', 'id') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id, sort_order);