const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { marked } = require('marked');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'secret-xda-mirror-key';

// Ensure data directory exists for SQLite
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'database.sqlite'));
db.pragma('journal_mode = WAL');

// Initialize database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    mode TEXT DEFAULT 'complex',
    title TEXT NOT NULL,
    device TEXT,
    version TEXT,
    file_size TEXT,
    md5 TEXT,
    sha256 TEXT,
    changelog TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS mirrors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    release_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    url TEXT NOT NULL,
    weight INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    FOREIGN KEY(release_id) REFERENCES releases(id) ON DELETE CASCADE
  );
`);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }
}));

function requireAuth(req, res, next) {
  if (req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

function getProviderMeta(provider) {
  const p = (provider || '').toLowerCase();
  if (p.includes('github')) return { icon: 'fa-brands fa-github' };
  if (p.includes('catbox') || p.includes('litterbox')) return { icon: 'fa-solid fa-box-open' };
  if (p.includes('google') || p.includes('gdrive') || p.includes('drive')) return { icon: 'fa-brands fa-google-drive' };
  if (p.includes('mega')) return { icon: 'fa-solid fa-m' };
  if (p.includes('sourceforge')) return { icon: 'fa-solid fa-bolt' };
  if (p.includes('mediafire')) return { icon: 'fa-solid fa-fire' };
  return { icon: 'fa-solid fa-cloud-arrow-down' };
}

// -------------------------------------------------------------
// 1. ADMIN ROUTES
// -------------------------------------------------------------

app.get('/admin/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.render('login', { error: 'Incorrect administrator password' });
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

app.get('/admin', requireAuth, (req, res) => {
  const releases = db.prepare(`
    SELECT r.*, 
      (SELECT COUNT(*) FROM mirrors m WHERE m.release_id = r.id) as mirror_count,
      (SELECT COALESCE(SUM(clicks), 0) FROM mirrors m WHERE m.release_id = r.id) as total_clicks
    FROM releases r
    ORDER BY r.id DESC
  `).all();

  res.render('admin', { releases, host: req.get('host'), protocol: req.protocol });
});

app.post('/admin/release', requireAuth, (req, res) => {
  const { slug, title, mode, device, version, file_size, md5, sha256, changelog, mirrors } = req.body;
  
  const insertRelease = db.prepare(`
    INSERT INTO releases (slug, title, mode, device, version, file_size, md5, sha256, changelog)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = insertRelease.run(
    slug.toLowerCase().trim().replace(/[^a-z0-9-_]/g, '-'),
    title,
    mode || 'complex',
    device || null,
    version || null,
    file_size || null,
    md5 ? md5.trim() : null,
    sha256 ? sha256.trim() : null,
    changelog || null
  );

  const releaseId = info.lastInsertRowid;

  if (mirrors && Array.isArray(mirrors)) {
    const insertMirror = db.prepare('INSERT INTO mirrors (release_id, provider, url, weight) VALUES (?, ?, ?, ?)');
    mirrors.forEach((m, index) => {
      if (m.url && m.provider) {
        const weight = m.weight ? parseInt(m.weight) : (1000 - (index * 10));
        insertMirror.run(releaseId, m.provider, m.url, weight);
      }
    });
  }

  res.json({ success: true, slug });
});

app.post('/admin/release/:id/delete', requireAuth, (req, res) => {
  db.prepare('DELETE FROM releases WHERE id = ?').run(req.params.id);
  res.redirect('/admin');
});

// -------------------------------------------------------------
// 2. DOWNLOAD & MIRROR REDIRECT ROUTES
// -------------------------------------------------------------

app.get('/dl/:mirrorId', (req, res) => {
  const mirror = db.prepare('SELECT * FROM mirrors WHERE id = ?').get(req.params.mirrorId);
  if (!mirror) return res.status(404).send('Mirror link not found.');

  db.prepare('UPDATE mirrors SET clicks = clicks + 1 WHERE id = ?').run(mirror.id);
  res.redirect(mirror.url);
});

app.get('/', (req, res) => {
  const latest = db.prepare('SELECT slug FROM releases ORDER BY id DESC LIMIT 1').get();
  if (latest) return res.redirect(`/${latest.slug}`);
  res.redirect('/admin');
});

// -------------------------------------------------------------
// 3. WILDCARD SLUG ROUTE
// -------------------------------------------------------------

app.get('/:slug', (req, res) => {
  const release = db.prepare('SELECT * FROM releases WHERE slug = ?').get(req.params.slug);
  if (!release) return res.status(404).send('Release not found.');

  const mirrors = db.prepare('SELECT * FROM mirrors WHERE release_id = ? ORDER BY weight DESC, id ASC').all(release.id);
  
  const mirrorsWithMeta = mirrors.map(m => ({
    ...m,
    meta: getProviderMeta(m.provider)
  }));

  const changelogHtml = release.changelog ? marked.parse(release.changelog) : null;

  res.render('download', { 
    release, 
    mirrors: mirrorsWithMeta, 
    changelogHtml,
    host: req.get('host'),
    protocol: req.protocol
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
