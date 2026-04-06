const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Helpers ───
const SEED_DIR = path.join(__dirname, 'data-seed'); // 初始資料（git 裡的）
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = fs.existsSync('/app/data') ? '/app/data/uploads' : path.join(__dirname, 'uploads');

// 確保 uploads 目錄存在
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Volume 初始化：如果 data 目錄是空的（新 Volume），從 seed 複製初始資料
(function initDataDir() {
  if (!fs.existsSync(SEED_DIR)) return; // 本地開發沒有 seed 目錄
  const dataFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  if (dataFiles.length === 0) {
    console.log('Volume 是空的，正在複製初始資料...');
    const seedFiles = fs.readdirSync(SEED_DIR).filter(f => f.endsWith('.json'));
    seedFiles.forEach(f => {
      fs.copyFileSync(path.join(SEED_DIR, f), path.join(DATA_DIR, f));
      console.log('  複製:', f);
    });
    console.log('初始資料複製完成！');
  }
})();

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8')); }
  catch { return file.endsWith('.json') && file !== 'menu.json' && !file.includes('settings') ? [] : {}; }
}

function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2), 'utf-8');
}

function genId() {
  return Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

// ─── Email Setup ───
const OWNER_EMAIL = 'a0931223353@gmail.com';
const HELPER_EMAIL = 'xushicun1967@gmail.com';
const SITE_URL = process.env.SITE_URL || 'https://lefunkyhouse-production.up.railway.app';

function genConfirmToken(id) {
  return crypto.createHash('sha256').update(id + 'lefunky-confirm-secret').digest('hex').slice(0, 16);
}

// ─── Email 寄信系統 ───
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const GMAIL_WEBHOOK_URL = process.env.GMAIL_WEBHOOK_URL || '';
const GMAIL_WEBHOOK_SECRET = 'lefunky-email-2024';

async function sendEmail({ to, subject, html, from }) {
  // 方法 1（推薦）：Google Apps Script Webhook（免費，可寄給任何人）
  if (GMAIL_WEBHOOK_URL) {
    console.log(`[Gmail Webhook] 寄信給 ${to}，主旨: ${subject}`);
    try {
      const resp = await fetch(GMAIL_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: GMAIL_WEBHOOK_SECRET, to, subject, html }),
        redirect: 'follow'
      });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (data.ok) {
        console.log('[Gmail Webhook] 寄信成功:', to);
        return true;
      } else {
        console.error('[Gmail Webhook] 寄信失敗:', data);
        // fallback 到 Resend
      }
    } catch (e) {
      console.error('[Gmail Webhook] 錯誤:', e.message);
      // fallback 到 Resend
    }
  }

  // 方法 2：Resend API（只能寄給註冊帳號信箱）
  if (RESEND_API_KEY) {
    const fromAddr = from || '"樂放音樂展演空間" <onboarding@resend.dev>';
    console.log(`[Resend] 寄信給 ${to}，主旨: ${subject}`);
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from: fromAddr, to: [to], subject, html })
      });
      const data = await resp.json();
      if (!resp.ok) {
        console.error('[Resend] 寄信失敗:', data);
        return false;
      }
      console.log('[Resend] 寄信成功:', data.id);
      return true;
    } catch (e) {
      console.error('[Resend] 寄信錯誤:', e.message);
      return false;
    }
  }

  // 方法 3：fallback 用 nodemailer SMTP（本地開發用）
  const settings = readJSON('settings.json');
  const smtp = settings.smtp || null;
  if (!smtp || !smtp.user || !smtp.pass) {
    console.log('未設定寄信方式，跳過寄信');
    return false;
  }
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host || 'smtp.gmail.com',
      port: smtp.port || 465,
      secure: smtp.secure !== undefined ? smtp.secure : true,
      auth: { user: smtp.user, pass: smtp.pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
    });
    await transporter.sendMail({
      from: `"樂放音樂展演空間" <${smtp.user}>`,
      to, subject, html
    });
    console.log('[SMTP] 寄信成功:', to);
    return true;
  } catch (e) {
    console.error('[SMTP] 寄信失敗:', e.message);
    return false;
  }
}

// 相容舊的 createTransporter / getEmailSettings
function getEmailSettings() {
  const settings = readJSON('settings.json');
  return settings.smtp || { host: 'smtp.gmail.com', port: 465, secure: true, user: 'a0931223353@gmail.com', pass: '' };
}
function createTransporter() { return null; } // 已改用 sendEmail()

async function sendReservationEmails(reservation) {
  const dateStr = reservation.date;
  const timeStr = reservation.time;

  // 寄給老闆娘的通知信（含確認按鈕）
  const confirmToken = genConfirmToken(reservation.id);
  const confirmUrl = `${SITE_URL}/api/reservations/${reservation.id}/confirm?token=${confirmToken}`;

  const ok = await sendEmail({
    to: OWNER_EMAIL,
    subject: `【新訂位通知】${reservation.name} - ${dateStr} ${timeStr} (${reservation.guests}位)`,
    html: `
      <div style="font-family:sans-serif;max-width:500px;padding:20px">
        <h2 style="color:#1e2d3d;border-bottom:2px solid #c4a55a;padding-bottom:8px">新訂位通知</h2>
        <table style="font-size:14px;line-height:2">
          <tr><td style="color:#888;padding-right:16px">姓名</td><td><strong>${reservation.name}</strong></td></tr>
          <tr><td style="color:#888">電話</td><td>${reservation.phone}</td></tr>
          <tr><td style="color:#888">Email</td><td>${reservation.email || '(未提供)'}</td></tr>
          <tr><td style="color:#888">日期</td><td>${dateStr}</td></tr>
          <tr><td style="color:#888">時間</td><td>${timeStr}</td></tr>
          <tr><td style="color:#888">人數</td><td>${reservation.guests} 位</td></tr>
          ${reservation.note ? `<tr><td style="color:#888">備註</td><td>${reservation.note}</td></tr>` : ''}
        </table>
        <div style="margin-top:24px;text-align:center">
          <a href="${confirmUrl}" style="display:inline-block;background:#4a8a5a;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-size:16px;font-weight:bold">✅ 確認此訂位</a>
        </div>
        <p style="color:#aaa;font-size:12px;margin-top:16px;text-align:center">點擊上方按鈕後，系統會自動更新訂位狀態${reservation.email ? '，並寄送確認信給客人' : ''}</p>
        <p style="color:#aaa;font-size:11px">送出時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}</p>
      </div>
    `
  });
  if (ok) console.log('已寄送訂位通知信給老闆娘');

  // 寄給小幫手（純通知，不含確認按鈕）
  sendEmail({
    to: HELPER_EMAIL,
    subject: `【訂位通知】${reservation.name} - ${dateStr} ${timeStr} (${reservation.guests}位)`,
    html: `
      <div style="font-family:sans-serif;max-width:500px;padding:20px">
        <h2 style="color:#1e2d3d;border-bottom:2px solid #c4a55a;padding-bottom:8px">訂位通知（副本）</h2>
        <table style="font-size:14px;line-height:2">
          <tr><td style="color:#888;padding-right:16px">姓名</td><td><strong>${reservation.name}</strong></td></tr>
          <tr><td style="color:#888">電話</td><td>${reservation.phone}</td></tr>
          <tr><td style="color:#888">日期</td><td>${dateStr}</td></tr>
          <tr><td style="color:#888">時間</td><td>${timeStr}</td></tr>
          <tr><td style="color:#888">人數</td><td>${reservation.guests} 位</td></tr>
          ${reservation.note ? `<tr><td style="color:#888">備註</td><td>${reservation.note}</td></tr>` : ''}
        </table>
        <p style="color:#aaa;font-size:12px;margin-top:16px">此為系統自動副本通知，請提醒老闆娘確認訂位。</p>
      </div>
    `
  }).then(() => console.log('已寄送訂位副本給小幫手')).catch(e => console.error('小幫手寄信錯誤:', e));
}

// ─── 確認訂位通知信（寄給客人）───
async function sendConfirmedEmail(reservation) {
  if (!reservation.email) return;
  await sendEmail({
    to: reservation.email,
    subject: `【樂放音樂展演空間】您的訂位已確認 - ${reservation.date} ${reservation.time}`,
    html: `
      <div style="font-family:'Noto Sans TC',sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f6f4ef;border-radius:12px">
        <div style="text-align:center;margin-bottom:24px">
          <h1 style="color:#1e2d3d;font-size:22px;margin:0">樂放音樂展演空間</h1>
          <p style="color:#c4a55a;font-size:14px;margin:4px 0">Le Funky House</p>
        </div>
        <div style="background:#fff;border-radius:8px;padding:24px;border:1px solid #e4dfd4">
          <h2 style="color:#4a8a5a;font-size:18px;margin:0 0 16px">✅ 訂位已確認</h2>
          <p style="color:#6a7a8a;font-size:14px;line-height:1.8;margin:0 0 16px">
            ${reservation.name} 您好，<br>
            您的訂位已確認成功，我們期待您的光臨！
          </p>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="padding:8px 0;color:#6a7a8a;width:80px">日期</td><td style="padding:8px 0;color:#1e2d3d;font-weight:500">${reservation.date}</td></tr>
            <tr><td style="padding:8px 0;color:#6a7a8a">時間</td><td style="padding:8px 0;color:#1e2d3d;font-weight:500">${reservation.time}</td></tr>
            <tr><td style="padding:8px 0;color:#6a7a8a">人數</td><td style="padding:8px 0;color:#1e2d3d;font-weight:500">${reservation.guests} 位</td></tr>
          </table>
          <hr style="border:none;border-top:1px solid #e4dfd4;margin:20px 0">
          <p style="color:#6a7a8a;font-size:13px;line-height:1.6;margin:0">
            📍 新北市淡水區中正路22巷1-1號（老街台電正對面）<br>
            📞 0931-223-353（王小姐）<br>
            ⚠️ 逾時 15 分鐘未到將自動取消訂位
          </p>
        </div>
        <p style="text-align:center;color:#a0a8b0;font-size:12px;margin-top:16px">此為系統自動發送，請勿直接回覆此信件</p>
      </div>
    `
  });
}

// ─── Middleware ───
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// ─── 批次上傳 API（用於遷移圖片到 Volume）───
app.post('/api/bulk-upload', authMiddleware, (req, res) => {
  const { filePath, data } = req.body; // filePath: "artists/xxx.jpg", data: base64
  if (!filePath || !data) return res.status(400).json({ error: '缺少參數' });
  const fullPath = path.join(UPLOADS_DIR, filePath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, Buffer.from(data, 'base64'));
  res.json({ ok: true, path: '/uploads/' + filePath });
});

// ─── Auth (persistent sessions) ───
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function loadSessions() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    const map = new Map();
    const now = Date.now();
    for (const [token, ts] of Object.entries(data)) {
      if (now - ts < 7 * 24 * 60 * 60 * 1000) map.set(token, ts); // 保留 7 天內的
    }
    return map;
  } catch { return new Map(); }
}

function saveSessions() {
  const obj = {};
  for (const [token, ts] of activeSessions) obj[token] = ts;
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj), 'utf-8');
}

const activeSessions = loadSessions();

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !activeSessions.has(token)) {
    return res.status(401).json({ error: '未授權' });
  }
  activeSessions.set(token, Date.now());
  saveSessions();
  next();
}

// Clean expired sessions (7 days)
setInterval(() => {
  const now = Date.now();
  for (const [token, ts] of activeSessions) {
    if (now - ts > 7 * 24 * 60 * 60 * 1000) activeSessions.delete(token);
  }
  saveSessions();
}, 60 * 60 * 1000);

// ─── File Upload Config ───
function makeStorage(subdir) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOADS_DIR, subdir);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, genId() + ext);
    }
  });
}

const uploadSchedule = multer({
  storage: makeStorage('schedule'),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(png|jpg|jpeg|webp)$/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  }
});

const uploadArtist = multer({
  storage: makeStorage('artists'),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(png|jpg|jpeg|webp)$/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  }
});

const uploadGallery = multer({
  storage: makeStorage('gallery'),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(png|jpg|jpeg|webp)$/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  }
});

// ═══════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const settings = readJSON('settings.json');
  if (password === settings.adminPassword) {
    const token = crypto.randomBytes(32).toString('hex');
    activeSessions.set(token, Date.now());
    saveSessions();
    res.json({ token });
  } else {
    res.status(401).json({ error: '密碼錯誤' });
  }
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  activeSessions.delete(token);
  saveSessions();
  res.json({ ok: true });
});

app.put('/api/settings/password', authMiddleware, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const settings = readJSON('settings.json');
  if (oldPassword !== settings.adminPassword) {
    return res.status(400).json({ error: '舊密碼錯誤' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: '新密碼太短' });
  }
  settings.adminPassword = newPassword;
  writeJSON('settings.json', settings);
  res.json({ ok: true });
});

// ═══════════════════════════════════════
//  NEWS
// ═══════════════════════════════════════
app.get('/api/news', (req, res) => {
  res.json(readJSON('news.json'));
});

app.post('/api/news', authMiddleware, (req, res) => {
  const { date, tag, text } = req.body;
  if (!date || !text) return res.status(400).json({ error: '缺少必填欄位' });
  const news = readJSON('news.json');
  const item = { id: genId(), date, tag: tag || '公告', text };
  news.unshift(item);
  writeJSON('news.json', news);
  res.json(item);
});

app.put('/api/news/:id', authMiddleware, (req, res) => {
  const news = readJSON('news.json');
  const idx = news.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '找不到' });
  Object.assign(news[idx], req.body);
  writeJSON('news.json', news);
  res.json(news[idx]);
});

app.delete('/api/news/:id', authMiddleware, (req, res) => {
  let news = readJSON('news.json');
  news = news.filter(n => n.id !== req.params.id);
  writeJSON('news.json', news);
  res.json({ ok: true });
});

// ═══════════════════════════════════════
//  ARTISTS
// ═══════════════════════════════════════
app.get('/api/artists', (req, res) => {
  res.json(readJSON('artists.json'));
});

app.post('/api/artists', authMiddleware, uploadArtist.single('photo'), (req, res) => {
  const { name, genre, bio, ig, youtube, spotify, order, photoFit, photoPosY, category } = req.body;
  if (!name) return res.status(400).json({ error: '請輸入歌手名稱' });
  const artists = readJSON('artists.json');
  const item = {
    id: genId(),
    name,
    genre: genre || '',
    bio: bio || '',
    photo: req.file ? `/uploads/artists/${req.file.filename}` : '',
    photoFit: photoFit || 'cover',
    photoPosY: parseInt(photoPosY) || 50,
    links: { ig: ig || '', youtube: youtube || '', spotify: spotify || '' },
    order: parseInt(order) || artists.length,
    category: category || 'resident'
  };
  // Auto-shift: if order conflicts, push others down
  const newOrder = item.order;
  artists.forEach(a => { if (a.order >= newOrder) a.order++; });
  artists.push(item);
  artists.sort((a, b) => a.order - b.order);
  writeJSON('artists.json', artists);
  res.json(item);
});

app.put('/api/artists/:id', authMiddleware, uploadArtist.single('photo'), (req, res) => {
  const artists = readJSON('artists.json');
  const idx = artists.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '找不到' });

  const { name, genre, bio, ig, youtube, spotify, order, photoFit, photoPosY, category } = req.body;
  if (name) artists[idx].name = name;
  if (genre !== undefined) artists[idx].genre = genre;
  if (bio !== undefined) artists[idx].bio = bio;
  const newCategory = category !== undefined ? category : (artists[idx].category || 'resident');
  const oldCategory = artists[idx].category || 'resident';
  if (category !== undefined) artists[idx].category = category;
  if (photoFit !== undefined) artists[idx].photoFit = photoFit;
  if (photoPosY !== undefined) artists[idx].photoPosY = parseInt(photoPosY) || 50;

  // Handle order within same category
  if (order !== undefined) {
    const newOrder = parseInt(order) || 1;
    const targetCat = newCategory;
    const thisId = artists[idx].id;
    // Get same category artists (excluding this one)
    const sameCat = artists.filter(a => a.id !== thisId && (a.category || 'resident') === targetCat);
    // Sort by current order
    sameCat.sort((a, b) => (a.order || 0) - (b.order || 0));
    // Insert at new position
    sameCat.splice(newOrder - 1, 0, artists[idx]);
    // Reassign orders for this category
    sameCat.forEach((a, i) => { a.order = i + 1; });
    // Also fix order for other category
    const otherCat = artists.filter(a => (a.category || 'resident') !== targetCat);
    otherCat.sort((a, b) => (a.order || 0) - (b.order || 0));
    otherCat.forEach((a, i) => { a.order = i + 1; });
  }
  artists[idx].links = {
    ig: ig !== undefined ? ig : artists[idx].links.ig,
    youtube: youtube !== undefined ? youtube : artists[idx].links.youtube,
    spotify: spotify !== undefined ? spotify : artists[idx].links.spotify
  };

  if (req.file) {
    // Delete old photo
    if (artists[idx].photo) {
      const oldPath = path.join(__dirname, artists[idx].photo);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    artists[idx].photo = `/uploads/artists/${req.file.filename}`;
  }

  artists.sort((a, b) => a.order - b.order);
  writeJSON('artists.json', artists);
  res.json(artists[idx]);
});

// 批次排序 API — 一次搞定
app.post('/api/artists/reorder', authMiddleware, (req, res) => {
  const { ids } = req.body; // 按順序排好的 id 陣列
  if (!Array.isArray(ids)) return res.status(400).json({ error: '需要 ids 陣列' });
  const artists = readJSON('artists.json');
  ids.forEach((id, i) => {
    const a = artists.find(x => x.id === id);
    if (a) a.order = i + 1;
  });
  artists.sort((a, b) => a.order - b.order);
  writeJSON('artists.json', artists);
  res.json({ ok: true });
});

app.delete('/api/artists/:id', authMiddleware, (req, res) => {
  let artists = readJSON('artists.json');
  const artist = artists.find(a => a.id === req.params.id);
  if (artist && artist.photo) {
    const photoPath = path.join(__dirname, artist.photo);
    if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
  }
  artists = artists.filter(a => a.id !== req.params.id);
  writeJSON('artists.json', artists);
  res.json({ ok: true });
});

// ═══════════════════════════════════════
//  SCHEDULE
// ═══════════════════════════════════════
app.get('/api/schedule', (req, res) => {
  const dir = path.join(UPLOADS_DIR, 'schedule');
  if (!fs.existsSync(dir)) return res.json({ images: [] });
  const order = readJSON('schedule-order.json'); // [{filename, order}]
  const files = fs.readdirSync(dir)
    .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .map(f => {
      const o = order.find(x => x.filename === f);
      return {
        filename: f,
        url: `/uploads/schedule/${f}`,
        uploadedAt: fs.statSync(path.join(dir, f)).mtime,
        order: o ? o.order : 999
      };
    })
    .sort((a, b) => a.order - b.order);
  res.json({ images: files });
});

app.post('/api/schedule', authMiddleware, uploadSchedule.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請上傳圖片' });
  // 加到排序最後
  const order = readJSON('schedule-order.json');
  const maxOrder = order.length ? Math.max(...order.map(x => x.order)) : -1;
  order.push({ filename: req.file.filename, order: maxOrder + 1 });
  writeJSON('schedule-order.json', order);
  res.json({
    filename: req.file.filename,
    url: `/uploads/schedule/${req.file.filename}`
  });
});

app.put('/api/schedule/reorder', authMiddleware, (req, res) => {
  const { filenames } = req.body; // ['file1.png', 'file2.png', ...] 按新順序
  if (!Array.isArray(filenames)) return res.status(400).json({ error: '格式錯誤' });
  const order = filenames.map((f, i) => ({ filename: f, order: i }));
  writeJSON('schedule-order.json', order);
  res.json({ ok: true });
});

app.delete('/api/schedule/:filename', authMiddleware, (req, res) => {
  const filePath = path.join(UPLOADS_DIR, 'schedule', req.params.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  // 從排序中移除
  let order = readJSON('schedule-order.json');
  order = order.filter(x => x.filename !== req.params.filename);
  writeJSON('schedule-order.json', order);
  res.json({ ok: true });
});

// ═══════════════════════════════════════
//  GALLERY
// ═══════════════════════════════════════
app.get('/api/gallery', (req, res) => {
  res.json(readJSON('gallery.json'));
});

app.post('/api/gallery', authMiddleware, uploadGallery.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請上傳圖片' });
  const gallery = readJSON('gallery.json');
  const item = {
    id: genId(),
    caption: req.body.caption || '',
    url: `/uploads/gallery/${req.file.filename}`,
    order: parseInt(req.body.order) || gallery.length
  };
  gallery.push(item);
  gallery.sort((a, b) => a.order - b.order);
  writeJSON('gallery.json', gallery);
  res.json(item);
});

app.put('/api/gallery/:id', authMiddleware, (req, res) => {
  const gallery = readJSON('gallery.json');
  const idx = gallery.findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '找不到' });
  if (req.body.caption !== undefined) gallery[idx].caption = req.body.caption;
  if (req.body.order !== undefined) gallery[idx].order = parseInt(req.body.order) || 0;
  gallery.sort((a, b) => a.order - b.order);
  writeJSON('gallery.json', gallery);
  res.json(gallery[idx]);
});

app.delete('/api/gallery/:id', authMiddleware, (req, res) => {
  let gallery = readJSON('gallery.json');
  const item = gallery.find(g => g.id === req.params.id);
  if (item) {
    const photoPath = path.join(__dirname, item.url);
    if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
  }
  gallery = gallery.filter(g => g.id !== req.params.id);
  writeJSON('gallery.json', gallery);
  res.json({ ok: true });
});

// ═══════════════════════════════════════
//  TICKETS
// ═══════════════════════════════════════
const uploadTicketPoster = multer({
  storage: makeStorage('tickets'),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(png|jpg|jpeg|webp)$/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  }
});

app.get('/api/tickets', (req, res) => {
  const tickets = readJSON('tickets.json');
  const orders = readJSON('ticket-orders.json');
  const token = req.headers.authorization?.replace('Bearer ', '');
  const isAdmin = token && activeSessions.has(token);
  // Calculate remaining for each ticket
  const ticketsWithRemaining = tickets.map(t => {
    const totalTickets = t.totalTickets || 0;
    let remaining;
    let soldQty;
    if (t.manualRemaining !== null && t.manualRemaining !== undefined) {
      // 有手動設定：以手動數字為基底，再扣掉設定之後確認的線上訂單
      const setAt = t.manualRemainingSetAt || '2000-01-01';
      const newConfirmed = orders.filter(o => o.ticketId === t.id && o.status === 'confirmed' && o.confirmedAt && o.confirmedAt > setAt)
        .reduce((sum, o) => sum + (o.quantity || 0), 0);
      remaining = Math.max(0, t.manualRemaining - newConfirmed);
      soldQty = totalTickets - remaining;
    } else {
      // 沒手動設定：用總票數減全部已確認訂單
      soldQty = orders.filter(o => o.ticketId === t.id && o.status === 'confirmed').reduce((sum, o) => sum + (o.quantity || 0), 0);
      remaining = Math.max(0, totalTickets - soldQty);
    }
    return { ...t, remaining, soldQty, soldOut: totalTickets > 0 && remaining <= 0 };
  });
  if (isAdmin) return res.json(ticketsWithRemaining);
  // Public: only on_sale and upcoming
  const now = new Date().toISOString().split('T')[0];
  res.json(ticketsWithRemaining.filter(t => t.date >= now));
});

app.post('/api/tickets', authMiddleware, uploadTicketPoster.single('poster'), (req, res) => {
  const { title, date, time, price, description, artist, totalTickets, manualRemaining, paymentDeadline, posterPosition } = req.body;
  if (!title || !date) return res.status(400).json({ error: '請填寫演出名稱和日期' });
  const tickets = readJSON('tickets.json');
  const item = {
    id: genId(),
    title, date, time: time || '',
    artist: artist || '',
    price: parseInt(price) || 0,
    description: description || '',
    venue: '樂放音樂展演空間',
    poster: req.file ? `/uploads/tickets/${req.file.filename}` : '',
    posterPosition: posterPosition || 'center',
    totalTickets: parseInt(totalTickets) || 0,
    manualRemaining: manualRemaining !== '' && manualRemaining !== undefined ? parseInt(manualRemaining) : null,
    paymentDeadline: paymentDeadline || '',
    status: 'on_sale',
    createdAt: new Date().toISOString()
  };
  tickets.push(item);
  tickets.sort((a, b) => a.date.localeCompare(b.date));
  writeJSON('tickets.json', tickets);
  res.json(item);
});

app.put('/api/tickets/:id', authMiddleware, uploadTicketPoster.single('poster'), (req, res) => {
  const tickets = readJSON('tickets.json');
  const idx = tickets.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '找不到' });
  const { title, date, time, price, description, artist, totalTickets, manualRemaining, paymentDeadline, posterPosition, status } = req.body;
  if (title !== undefined) tickets[idx].title = title;
  if (date !== undefined) tickets[idx].date = date;
  if (time !== undefined) tickets[idx].time = time;
  if (price !== undefined) tickets[idx].price = parseInt(price) || 0;
  if (description !== undefined) tickets[idx].description = description;
  if (artist !== undefined) tickets[idx].artist = artist;
  if (totalTickets !== undefined) tickets[idx].totalTickets = parseInt(totalTickets) || 0;
  if (manualRemaining !== undefined) {
    const newVal = manualRemaining !== '' ? parseInt(manualRemaining) : null;
    if (newVal !== null) {
      tickets[idx].manualRemaining = newVal;
      tickets[idx].manualRemainingSetAt = new Date().toISOString();
    } else {
      tickets[idx].manualRemaining = null;
      tickets[idx].manualRemainingSetAt = null;
    }
  }
  if (paymentDeadline !== undefined) tickets[idx].paymentDeadline = paymentDeadline;
  if (posterPosition !== undefined) tickets[idx].posterPosition = posterPosition;
  if (status !== undefined) tickets[idx].status = status;
  if (req.file) {
    if (tickets[idx].poster) {
      const oldPath = path.join(__dirname, tickets[idx].poster);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    tickets[idx].poster = `/uploads/tickets/${req.file.filename}`;
  }
  tickets.sort((a, b) => a.date.localeCompare(b.date));
  writeJSON('tickets.json', tickets);
  res.json(tickets[idx]);
});

app.delete('/api/tickets/:id', authMiddleware, (req, res) => {
  let tickets = readJSON('tickets.json');
  const ticket = tickets.find(t => t.id === req.params.id);
  if (ticket && ticket.poster) {
    const p = path.join(__dirname, ticket.poster);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  tickets = tickets.filter(t => t.id !== req.params.id);
  writeJSON('tickets.json', tickets);
  res.json({ ok: true });
});

// ═══════════════════════════════════════
//  TICKET ORDERS
// ═══════════════════════════════════════

// Public: create order
app.post('/api/ticket-orders', async (req, res) => {
  const { name, phone, email, ticketId, quantity, bankLast5, hasPaid } = req.body;
  if (!name || !phone || !ticketId || !quantity || !bankLast5) {
    return res.status(400).json({ error: '請填寫所有必填欄位' });
  }
  const tickets = readJSON('tickets.json');
  const ticket = tickets.find(t => t.id === ticketId);
  if (!ticket) return res.status(404).json({ error: '找不到該演出' });

  // Check remaining
  const orders = readJSON('ticket-orders.json');
  const soldQty = orders.filter(o => o.ticketId === ticketId && o.status !== 'cancelled').reduce((sum, o) => sum + (o.quantity || 0), 0);
  const totalTickets = ticket.totalTickets || 0;
  const remaining = totalTickets > 0 ? totalTickets - soldQty : 999;
  if (remaining < quantity) {
    return res.status(400).json({ error: `票數不足，目前剩餘 ${remaining} 張` });
  }

  const order = {
    id: genId(),
    ticketId,
    ticketTitle: ticket.title,
    name,
    phone,
    email: email || '',
    quantity: parseInt(quantity) || 1,
    bankLast5,
    hasPaid: hasPaid === true || hasPaid === 'true',
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  orders.push(order);
  writeJSON('ticket-orders.json', orders);

  // 先回應客人，不要讓客人等寄信
  res.json(order);

  // 背景寄信通知老闆娘
  (async () => {
    try {
      const confirmToken = genConfirmToken(order.id);
      const confirmUrl = `${SITE_URL}/api/ticket-orders/${order.id}/confirm?token=${confirmToken}`;
      const artistText = ticket.artist ? `${ticket.artist} - ` : '';
      await sendEmail({
        to: OWNER_EMAIL,
        subject: `【新購票通知】${order.name} - ${artistText}${ticket.title} (${order.quantity}張)`,
        html: `
          <div style="font-family:sans-serif;max-width:500px;padding:20px">
            <h2 style="color:#1e2d3d;border-bottom:2px solid #c4a55a;padding-bottom:8px">新購票通知</h2>
            <table style="font-size:14px;line-height:2">
              <tr><td style="color:#888;padding-right:16px">演出場次</td><td><strong>${artistText}${ticket.title}</strong></td></tr>
              <tr><td style="color:#888">演出日期</td><td>${ticket.date} ${ticket.time}</td></tr>
              <tr><td style="color:#888">姓名</td><td>${order.name}</td></tr>
              <tr><td style="color:#888">電話</td><td>${order.phone}</td></tr>
              <tr><td style="color:#888">Email</td><td>${order.email}</td></tr>
              <tr><td style="color:#888">票數</td><td>${order.quantity} 張</td></tr>
              <tr><td style="color:#888">帳號末五碼</td><td>${order.bankLast5}</td></tr>
              <tr><td style="color:#888">已匯款</td><td>${order.hasPaid ? '是' : '否'}</td></tr>
            </table>
            <div style="margin-top:24px;text-align:center">
              <a href="${confirmUrl}" style="display:inline-block;background:#4a8a5a;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-size:16px;font-weight:bold">✅ 確認此購票</a>
            </div>
            <p style="color:#aaa;font-size:12px;margin-top:16px;text-align:center">點擊上方按鈕後，系統會自動寄送購票確認信給 ${order.email}</p>
            <p style="color:#aaa;font-size:11px">送出時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}</p>
          </div>
          `
      });
    } catch (e) {
      console.error('寄送購票通知信失敗:', e.message);
    }
  })();
});

// Admin: get all orders
app.get('/api/ticket-orders', authMiddleware, (req, res) => {
  const orders = readJSON('ticket-orders.json');
  res.json(orders);
});

// Admin: get orders for specific show
app.get('/api/ticket-orders/:ticketId', authMiddleware, (req, res) => {
  const orders = readJSON('ticket-orders.json');
  res.json(orders.filter(o => o.ticketId === req.params.ticketId));
});

// Admin: update order (mark paid/confirmed)
app.patch('/api/ticket-orders/:id', authMiddleware, (req, res) => {
  const orders = readJSON('ticket-orders.json');
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '找不到訂單' });
  const { hasPaid, status } = req.body;
  if (hasPaid !== undefined) orders[idx].hasPaid = hasPaid === true || hasPaid === 'true';
  if (status !== undefined) orders[idx].status = status;
  writeJSON('ticket-orders.json', orders);
  res.json(orders[idx]);
});

// Confirm ticket order (from owner email link)
app.get('/api/ticket-orders/:id/confirm', async (req, res) => {
  const expectedToken = genConfirmToken(req.params.id);
  if (req.query.token !== expectedToken) return res.status(403).send('無效的確認連結');
  const orders = readJSON('ticket-orders.json');
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).send('找不到此訂單');
  if (orders[idx].status === 'confirmed') return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>此購票已確認過囉！</h2><p>確認信已寄出給客人。</p></body></html>');
  orders[idx].status = 'confirmed';
  orders[idx].hasPaid = true;
  orders[idx].confirmedAt = new Date().toISOString();
  writeJSON('ticket-orders.json', orders);
  // Send confirmation email to buyer
  if (orders[idx].email) {
    const tickets = readJSON('tickets.json');
    const ticket = tickets.find(t => t.id === orders[idx].ticketId);
    const artistText = ticket?.artist ? `${ticket.artist} - ` : '';
    const showTitle = ticket ? `${artistText}${ticket.title}` : orders[idx].ticketTitle;
    const showDate = ticket ? `${ticket.date} ${ticket.time}` : '';
    sendEmail({
      to: orders[idx].email,
      subject: `【樂放音樂展演空間】購票確認 - ${showTitle}`,
      html: `
        <div style="font-family:'Noto Sans TC',sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f6f4ef;border-radius:12px">
          <div style="text-align:center;margin-bottom:24px">
            <h1 style="color:#1e2d3d;font-size:22px;margin:0">樂放音樂展演空間</h1>
            <p style="color:#c4a55a;font-size:14px;margin:4px 0">Le Funky House</p>
          </div>
          <div style="background:#fff;border-radius:8px;padding:24px;border:1px solid #e4dfd4">
            <h2 style="color:#4a8a5a;font-size:18px;margin:0 0 16px">✅ 購票已確認</h2>
            <p style="color:#6a7a8a;font-size:14px;line-height:1.8;margin:0 0 16px">
              ${orders[idx].name} 您好，<br>
              您的購票已確認成功！演出當日請出示此確認信入場。
            </p>
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <tr><td style="padding:8px 0;color:#6a7a8a;width:80px">演出</td><td style="padding:8px 0;color:#1e2d3d;font-weight:500">${showTitle}</td></tr>
              <tr><td style="padding:8px 0;color:#6a7a8a">日期時間</td><td style="padding:8px 0;color:#1e2d3d;font-weight:500">${showDate}</td></tr>
              <tr><td style="padding:8px 0;color:#6a7a8a">票數</td><td style="padding:8px 0;color:#1e2d3d;font-weight:500">${orders[idx].quantity} 張</td></tr>
              <tr><td style="padding:8px 0;color:#6a7a8a">姓名</td><td style="padding:8px 0;color:#1e2d3d;font-weight:500">${orders[idx].name}</td></tr>
            </table>
            <hr style="border:none;border-top:1px solid #e4dfd4;margin:20px 0">
            <p style="color:#6a7a8a;font-size:13px;line-height:1.6;margin:0">
              📍 新北市淡水區中正路22巷1-1號（老街台電正對面）<br>
              📞 0931-223-353（王小姐）
            </p>
          </div>
          <p style="text-align:center;color:#a0a8b0;font-size:12px;margin-top:16px">此為系統自動發送，請勿直接回覆此信件</p>
        </div>
      `
    }).catch(e => console.error('寄送購票確認信失敗:', e.message));
  }
  res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2 style="color:#4a8a5a">✅ 購票已確認！</h2><p>已寄送確認信給 ' + orders[idx].email + '</p></body></html>');
});

// Admin: delete order
app.delete('/api/ticket-orders/:id', authMiddleware, (req, res) => {
  let orders = readJSON('ticket-orders.json');
  orders = orders.filter(o => o.id !== req.params.id);
  writeJSON('ticket-orders.json', orders);
  res.json({ ok: true });
});

// ═══════════════════════════════════════
//  MENU (legacy text-based - kept for compatibility)
// ═══════════════════════════════════════
app.get('/api/menu', (req, res) => {
  res.json(readJSON('menu.json'));
});

app.put('/api/menu', authMiddleware, (req, res) => {
  writeJSON('menu.json', req.body);
  res.json({ ok: true });
});

// ═══════════════════════════════════════
//  MENU IMAGES
// ═══════════════════════════════════════
const uploadMenu = multer({
  storage: makeStorage('menu'),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(png|jpg|jpeg|webp)$/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  }
});

app.get('/api/menu-images', (req, res) => {
  const images = readJSON('menu-images.json');
  res.json(images);
});

app.post('/api/menu-images', authMiddleware, uploadMenu.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請上傳圖片' });
  const images = readJSON('menu-images.json');
  const item = {
    id: genId(),
    filename: req.file.filename,
    url: `/uploads/menu/${req.file.filename}`,
    caption: req.body.caption || '',
    order: parseInt(req.body.order) || images.length
  };
  images.push(item);
  images.sort((a, b) => a.order - b.order);
  writeJSON('menu-images.json', images);
  res.json(item);
});

app.delete('/api/menu-images/:id', authMiddleware, (req, res) => {
  let images = readJSON('menu-images.json');
  const item = images.find(i => i.id === req.params.id);
  if (item) {
    const filePath = path.join(UPLOADS_DIR, 'menu', item.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  images = images.filter(i => i.id !== req.params.id);
  writeJSON('menu-images.json', images);
  res.json({ ok: true });
});

// ═══════════════════════════════════════
//  RESERVATIONS
// ═══════════════════════════════════════
app.get('/api/reservations', (req, res) => {
  // Public: only future; Admin (with auth): all
  const token = req.headers.authorization?.replace('Bearer ', '');
  const isAdmin = token && activeSessions.has(token);
  let list = readJSON('reservations.json');
  if (!isAdmin) {
    const today = new Date().toISOString().split('T')[0];
    list = list.filter(r => r.date >= today && r.status !== 'cancelled');
  }
  list.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  res.json(list);
});

app.post('/api/reservations', async (req, res) => {
  const { name, phone, email, date, time, guests, note } = req.body;
  if (!name || !phone || !date || !time || !guests) {
    return res.status(400).json({ error: '缺少必填欄位' });
  }
  const list = readJSON('reservations.json');
  const item = {
    id: genId(),
    name, phone, email: email || '', date, time, guests, note: note || '',
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  list.push(item);
  writeJSON('reservations.json', list);
  res.json(item);

  // 非同步寄信（不阻塞回應）
  sendReservationEmails(item).catch(e => console.error('寄信錯誤:', e));
});

// 老闆娘從 Email 點「確認訂位」按鈕
app.get('/api/reservations/:id/confirm', async (req, res) => {
  const token = req.query.token;
  const expectedToken = genConfirmToken(req.params.id);
  if (token !== expectedToken) {
    return res.status(403).send('<h2>連結無效或已過期</h2>');
  }
  const list = readJSON('reservations.json');
  const idx = list.findIndex(r => r.id === req.params.id);
  if (idx === -1) {
    return res.status(404).send('<h2>找不到此訂位</h2>');
  }
  if (list[idx].status === 'confirmed') {
    return res.send(`
      <div style="font-family:sans-serif;max-width:500px;margin:60px auto;text-align:center;padding:40px">
        <h1 style="color:#c4a55a;font-size:48px;margin:0">✅</h1>
        <h2 style="color:#1e2d3d">此訂位已確認過囉</h2>
        <p style="color:#888">${list[idx].name} - ${list[idx].date} ${list[idx].time} (${list[idx].guests}位)</p>
      </div>
    `);
  }
  list[idx].status = 'confirmed';
  writeJSON('reservations.json', list);

  // 如果客人有留 Email，自動寄確認信
  if (list[idx].email) {
    sendConfirmedEmail(list[idx]).catch(e => console.error('寄確認信錯誤:', e));
  }

  res.send(`
    <div style="font-family:sans-serif;max-width:500px;margin:60px auto;text-align:center;padding:40px">
      <h1 style="color:#4a8a5a;font-size:48px;margin:0">✅</h1>
      <h2 style="color:#1e2d3d">訂位已確認成功！</h2>
      <p style="color:#888;font-size:15px;line-height:1.8">
        ${list[idx].name} - ${list[idx].date} ${list[idx].time} (${list[idx].guests}位)<br>
        ${list[idx].email ? '已自動寄送確認信給客人 (' + list[idx].email + ')' : '客人未提供 Email，不會寄送確認信'}
      </p>
      <p style="margin-top:24px"><a href="/admin#reservations" style="color:#c4a55a;text-decoration:none">前往後台管理 →</a></p>
    </div>
  `);
});

app.patch('/api/reservations/:id', authMiddleware, async (req, res) => {
  const list = readJSON('reservations.json');
  const idx = list.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '找不到' });
  const oldStatus = list[idx].status;
  if (req.body.status) list[idx].status = req.body.status;
  writeJSON('reservations.json', list);
  res.json(list[idx]);

  // 確認訂位時，寄信通知客人
  if (req.body.status === 'confirmed' && oldStatus !== 'confirmed' && list[idx].email) {
    sendConfirmedEmail(list[idx]).catch(e => console.error('寄確認信錯誤:', e));
  }
});

app.delete('/api/reservations/:id', authMiddleware, (req, res) => {
  let list = readJSON('reservations.json');
  list = list.filter(r => r.id !== req.params.id);
  writeJSON('reservations.json', list);
  res.json({ ok: true });
});

// ═══════════════════════════════════════
//  Blocked Dates (不可預約日期)
// ═══════════════════════════════════════
// blocked-dates.json format: [{ id, date: "2026-04-15", reason: "包場", allDay: true, blockedTimes: [] }]
app.get('/api/blocked-dates', (req, res) => {
  const list = readJSON('blocked-dates.json');
  res.json(list);
});

app.post('/api/blocked-dates', authMiddleware, (req, res) => {
  const { date, reason, allDay, blockedTimes } = req.body;
  if (!date) return res.status(400).json({ error: '請選擇日期' });
  const list = readJSON('blocked-dates.json');
  const item = { id: genId(), date, reason: reason || '', allDay: allDay !== false, blockedTimes: blockedTimes || [] };
  list.push(item);
  writeJSON('blocked-dates.json', list);
  res.json(item);
});

app.put('/api/blocked-dates/:id', authMiddleware, (req, res) => {
  const list = readJSON('blocked-dates.json');
  const idx = list.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '找不到' });
  const { date, reason, allDay, blockedTimes } = req.body;
  if (date) list[idx].date = date;
  if (reason !== undefined) list[idx].reason = reason;
  if (allDay !== undefined) list[idx].allDay = allDay;
  if (blockedTimes !== undefined) list[idx].blockedTimes = blockedTimes;
  writeJSON('blocked-dates.json', list);
  res.json(list[idx]);
});

app.delete('/api/blocked-dates/:id', authMiddleware, (req, res) => {
  let list = readJSON('blocked-dates.json');
  list = list.filter(b => b.id !== req.params.id);
  writeJSON('blocked-dates.json', list);
  res.json({ ok: true });
});

// ═══════════════════════════════════════
//  SMTP Settings
// ═══════════════════════════════════════
app.get('/api/smtp-settings', authMiddleware, (req, res) => {
  const settings = readJSON('settings.json');
  const smtp = settings.smtp || { host: '', port: 587, secure: false, user: '', pass: '' };
  // 不回傳密碼明文
  res.json({ ...smtp, pass: smtp.pass ? '••••••••' : '' });
});

app.post('/api/smtp-settings', authMiddleware, (req, res) => {
  const { host, port, secure, user, pass } = req.body;
  const settings = readJSON('settings.json');
  const existing = settings.smtp || {};
  settings.smtp = {
    host: host || existing.host || '',
    port: parseInt(port) || 587,
    secure: !!secure,
    user: user || existing.user || '',
    pass: (pass && pass !== '••••••••') ? pass : (existing.pass || '')
  };
  writeJSON('settings.json', settings);
  res.json({ ok: true, message: 'SMTP 設定已儲存' });
});

app.post('/api/smtp-test', authMiddleware, async (req, res) => {
  try {
    const ok = await sendEmail({
      to: OWNER_EMAIL,
      subject: '【測試】Email 設定成功 - 樂放音樂展演空間',
      html: '<div style="font-family:sans-serif;padding:20px"><h2>✅ Email 通知設定成功！</h2><p>恭喜！系統已能正常寄送通知到此信箱。</p><p style="color:#888;font-size:13px">訂位與購票通知將自動寄送到此信箱。</p></div>'
    });
    if (ok) {
      res.json({ ok: true, message: '測試信已寄出，請檢查信箱（含垃圾郵件）' });
    } else {
      res.status(400).json({ error: '寄信失敗，請檢查 RESEND_API_KEY 或 SMTP 設定' });
    }
  } catch (e) {
    res.status(400).json({ error: '寄信失敗: ' + e.message });
  }
});

// ─── SPA fallback ───
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ───
app.listen(PORT, async () => {
  console.log(`🎵 樂放音樂展演空間 running at http://localhost:${PORT}`);
  console.log(`   Admin panel: http://localhost:${PORT}/admin`);
  console.log(`   SITE_URL: ${SITE_URL}`);
  console.log(`   OWNER_EMAIL: ${OWNER_EMAIL}`);

  // 檢查 Email 設定
  if (GMAIL_WEBHOOK_URL) {
    console.log('✅ Gmail Webhook 已設定，Email 通知已啟用（可寄給任何人）');
  }
  if (RESEND_API_KEY) {
    console.log('✅ Resend API Key 已設定（備用寄信管道）');
  }
  if (!GMAIL_WEBHOOK_URL && !RESEND_API_KEY) {
    console.log('⚠️  未設定寄信方式，請設定 GMAIL_WEBHOOK_URL 或 RESEND_API_KEY');
  }
});
