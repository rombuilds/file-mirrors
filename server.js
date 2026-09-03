const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'mirrors.json');

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Ensure JSON database exists
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({}));
}

function getDatabase() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    return {};
  }
}

function saveDatabase(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// 1. Homepage (Create Mirrors Form)
app.get('/', (req, res) => {
  res.render('index');
});

// 2. Form Submission Handler
app.post('/create', (req, res) => {
  const { fileName, fileSize, mirrors, enableAds, adProvider } = req.body;

  if (!fileName || !mirrors) {
    return res.status(400).send('File name and at least one mirror are required.');
  }

  // Parse mirror URLs (one per line or comma-separated)
  const mirrorList = (Array.isArray(mirrors) ? mirrors : mirrors.split('\n'))
    .map(url => url.trim())
    .filter(url => url.length > 0);

  // Generate short 6-char ID
  const id = crypto.randomBytes(3).toString('hex');

  // STRICT AD TOGGLE: OFF by default
  const adsEnabled = enableAds === 'on' || enableAds === 'true' || enableAds === true;
  const chosenProvider = adsEnabled ? (adProvider || 'aads') : 'none';

  const db = getDatabase();
  db[id] = {
    id,
    fileName,
    fileSize: fileSize || 'Direct Download',
    mirrors: mirrorList,
    enableAds: adsEnabled,       // boolean (false if unchecked)
    adProvider: chosenProvider,  // 'aads', 'adsterra', 'split', or 'none'
    createdAt: new Date().toISOString()
  };
  saveDatabase(db);

  res.redirect(`/${id}`);
});

// 3. View / Download Page
app.get('/:id', (req, res) => {
  const db = getDatabase();
  const file = db[req.params.id];

  if (!file) {
    return res.status(404).send('File mirror link not found or expired.');
  }

  // Determine active ad network for this request
  let activeNetwork = 'none';
  if (file.enableAds) {
    if (file.adProvider === 'split') {
      // 50/50 Randomizer
      activeNetwork = Math.random() < 0.5 ? 'aads' : 'adsterra';
    } else {
      activeNetwork = file.adProvider || 'aads';
    }
  }

  res.render('view', {
    file,
    showAds: file.enableAds,     // true or false
    adNetwork: activeNetwork    // 'aads', 'adsterra', or 'none'
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
