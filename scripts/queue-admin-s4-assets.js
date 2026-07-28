// Queue existing administrator image assets for the optional private S4 mirror.
// Run after the 011 migration and with PENMARK_S4_* configured in .env.
require('../env');
const db = require('../database');
const { createS4Client } = require('../s4');

async function main() {
  if (!db.isPostgres()) throw new Error('This command is only for the PostgreSQL web deployment');
  const s4 = createS4Client();
  if (!s4.enabled) throw new Error('Set PENMARK_S4_ENABLED=1 plus bucket and server-side access keys first');

  const result = await db.execute(`
    UPDATE media_assets AS a
       SET remote_provider = 's4',
           remote_key = COALESCE(NULLIF(a.remote_key, ''), 'penmark/admin/' || a.id ||
             CASE a.mime_type
               WHEN 'image/png' THEN '.png'
               WHEN 'image/jpeg' THEN '.jpg'
               WHEN 'image/gif' THEN '.gif'
               WHEN 'image/webp' THEN '.webp'
               WHEN 'image/avif' THEN '.avif'
               ELSE '.bin'
             END),
           remote_status = 'pending',
           remote_attempted_at = NULL,
           remote_error = NULL
      FROM users AS u
     WHERE a.owner_id = u.id
       AND u.is_admin = 1
       AND (a.remote_provider <> 's4' OR a.remote_status <> 'ready' OR a.remote_key IS NULL)
  `);
  console.log('Queued ' + result.changes + ' existing administrator image asset(s) for S4 mirroring.');
  console.log('Restart the PenMark PM2 process once to begin the queue immediately.');
}

main()
  .then(() => db.close())
  .catch(async err => {
    console.error('Could not queue S4 assets:', err.message);
    await db.close().catch(() => {});
    process.exitCode = 1;
  });
