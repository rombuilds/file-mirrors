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

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'database.sqlite'));
db.pragma('journal_mode = WAL');

// Initialize database schema with Analytics Logging
db.exec(`
  CREATE TABLE IF NOT EXISTS hosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    icon TEXT DEFAULT 'fa-solid fa-cloud-arrow-down',
    weight INTEGER DEFAULT 0
  );

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
    clicks INTEGER DEFAULT 0,
    FOREIGN KEY(release_id) REFERENCES releases(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS click_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    release_id INTEGER NOT NULL,
    mirror_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed default universal hosts if empty
const hostCount = db.prepare('SELECT COUNT(*) as count FROM hosts').get().count;
if (hostCount === 0) {
  const seedHosts = [
    { name: 'GitHub Releases', icon: 'fa-brands fa-github', weight: 1000 },
    { name: 'Catbox', icon: 'fa-solid fa-box-open', weight: 900 },
    { name: 'SourceForge', icon: 'fa-solid fa-bolt', weight: 800 },
    { name: 'Google Drive', icon: 'fa-brands fa-google-drive', weight: 700 },
    { name: 'Mega', icon: 'fa-solid fa-m', weight: 600 },
    { name: 'MediaFire', icon: 'fa-solid fa-fire', weight: 500 },
    { name: 'Pixeldrain', icon: 'fa-solid fa-cloud-arrow-down', weight: 450 },
    { name: 'AndroidFileHost', icon: 'fa-solid fa-server', weight: 400 }
  ];
  const insertHost = db.prepare('INSERT INTO hosts (name, icon, weight) VALUES (?, ?, ?)');
  seedHosts.forEach(h => insertHost.run(h.name, h.icon, h.weight));
}

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

// Admin Dashboard with Analytics Queries
app.get('/admin', requireAuth, (req, res) => {
  const releases = db.prepare(`
    SELECT r.*, 
      (SELECT COUNT(*) FROM mirrors m WHERE m.release_id = r.id) as mirror_count,
      (SELECT COALESCE(SUM(clicks), 0) FROM mirrors m WHERE m.release_id = r.id) as total_clicks
    FROM releases r
    ORDER BY r.id DESC
  `).all();

  // Attach mirrors list to each release for detailed analytics
  const getMirrors = db.prepare('SELECT id, provider, url, clicks FROM mirrors WHERE release_id = ? ORDER BY clicks DESC');
  releases.forEach(r => {
    r.mirrors = getMirrors.all(r.id);
  });

  // Global Analytics
  const totalDownloads = db.prepare('SELECT COUNT(*) as count FROM click_logs').get().count;
  const downloads24h = db.prepare(`
    SELECT COUNT(*) as count FROM click_logs 
    WHERE clicked_at >= datetime('now', '-1 day')
  `).get().count;
  
  const topHost = db.prepare(`
    SELECT provider, COUNT(*) as clicks 
    FROM click_logs 
    GROUP BY provider 
    ORDER BY clicks DESC 
    LIMIT 1
  `).get();

  const hosts = db.prepare('SELECT * FROM hosts ORDER BY weight DESC, id ASC').all();

  res.render('admin', { 
    releases, 
    hosts, 
    stats: {
      totalDownloads,
      downloads24h,
      topHostName: topHost ? topHost.provider : 'N/A',
      topHostClicks: topHost ? topHost.clicks : 0
    },
    host: req.get('host'), 
    protocol: req.protocol 
  });
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
    const insertMirror = db.prepare('INSERT INTO mirrors (release_id, provider, url) VALUES (?, ?, ?)');
    mirrors.forEach(m => {
      if (m.url && m.provider) {
        insertMirror.run(releaseId, m.provider, m.url);
      }
    });
  }

  res.json({ success: true, slug });
});

app.post('/admin/release/:id/delete', requireAuth, (req, res) => {
  db.prepare('DELETE FROM releases WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM click_logs WHERE release_id = ?').run(req.params.id);
  res.redirect('/admin');
});

app.post('/admin/hosts/add', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  const lowest = db.prepare('SELECT MIN(weight) as min_weight FROM hosts').get();
  const nextWeight = (lowest && lowest.min_weight !== null) ? lowest.min_weight - 10 : 100;

  try {
    db.prepare('INSERT INTO hosts (name, weight) VALUES (?, ?)').run(name.trim(), nextWeight);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'Host already exists' });
  }
});

app.post('/admin/hosts/reorder', requireAuth, (req, res) => {
  const { orderedHostIds } = req.body;
  if (!Array.isArray(orderedHostIds)) return res.status(400).json({ error: 'Invalid data' });

  const updateWeight = db.prepare('UPDATE hosts SET weight = ? WHERE id = ?');
  const updateMany = db.transaction((ids) => {
    ids.forEach((id, index) => {
      const weight = 10000 - (index * 10);
      updateWeight.run(weight, id);
    });
  });

  updateMany(orderedHostIds);
  res.json({ success: true });
});

app.post('/admin/hosts/:id/delete', requireAuth, (req, res) => {
  db.prepare('DELETE FROM hosts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// -------------------------------------------------------------
// 2. DOWNLOAD & REDIRECT ROUTES (TRACKING CLICKS)
// -------------------------------------------------------------

app.get('/dl/:mirrorId', (req, res) => {
  const mirror = db.prepare('SELECT * FROM mirrors WHERE id = ?').get(req.params.mirrorId);
  if (!mirror) return res.status(404).send('Mirror link not found.');

  // Increment mirror counter & log timestamp for analytics
  db.prepare('UPDATE mirrors SET clicks = clicks + 1 WHERE id = ?').run(mirror.id);
  db.prepare('INSERT INTO click_logs (release_id, mirror_id, provider) VALUES (?, ?, ?)').run(
    mirror.release_id,
    mirror.id,
    mirror.provider
  );

  res.redirect(mirror.url);
});

app.get('/', (req, res) => {
  const latest = db.prepare('SELECT slug FROM releases ORDER BY id DESC LIMIT 1').get();
  if (latest) return res.redirect(`/${latest.slug}`);
  res.redirect('/admin');
});

app.get('/:slug', (req, res) => {
  const release = db.prepare('SELECT * FROM releases WHERE slug = ?').get(req.params.slug);
  if (!release) return res.status(404).send('Release not found.');

  const mirrors = db.prepare(`
    SELECT m.*, 
      COALESCE(h.weight, 0) as host_weight,
      COALESCE(h.icon, 'fa-solid fa-cloud-arrow-down') as host_icon
    FROM mirrors m
    LEFT JOIN hosts h ON LOWER(TRIM(m.provider)) = LOWER(TRIM(h.name))
    WHERE m.release_id = ?
    ORDER BY host_weight DESC, m.id ASC
  `).all(release.id);

  const changelogHtml = release.changelog ? marked.parse(release.changelog) : null;

  res.render('download', { 
    release, 
    mirrors, 
    changelogHtml,
    host: req.get('host'),
    protocol: req.protocol
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
