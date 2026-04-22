const http = require('http');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const HISTORY_TIME_ZONE = process.env.HISTORY_TIME_ZONE || 'Asia/Tashkent';
const HISTORY_CHANNEL_ID = process.env.HISTORY_CHANNEL_ID || '';
const ADMIN_BUTTONS = {
  users: "Barcha userlar ro'yxati",
  planned: 'Rejalashtirilgan ruxsatlar',
  app: 'Telegram mini appni ochish'
};
const adminModes = new Map();

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fsSync.existsSync(envPath)) return;
  const lines = fsSync.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

async function ensureDb() {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  if (!fsSync.existsSync(DB_PATH)) {
    await fs.writeFile(DB_PATH, JSON.stringify({ users: [], plannedPermissions: [] }, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const raw = await fs.readFile(DB_PATH, 'utf8');
  try {
    const db = JSON.parse(raw);
    if (!Array.isArray(db.users)) db.users = [];
    if (!Array.isArray(db.plannedPermissions)) db.plannedPermissions = [];
    return db;
  } catch (err) {
    return { users: [], plannedPermissions: [] };
  }
}

async function writeDb(db) {
  await ensureDb();
  const tmp = DB_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(db, null, 2));
  await fs.rename(tmp, DB_PATH);
}

function normalizeId(value) {
  return value === undefined || value === null ? '' : String(value);
}

function displayName(from, fallback = '') {
  if (!from) return fallback;
  return [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || from.username || fallback;
}

function publicUser(user) {
  return {
    id: user.id,
    telegramId: user.telegramId,
    username: user.username || '',
    fullName: user.fullName || '',
    phone: user.phone || '',
    status: user.status || 'new',
    createdAt: user.createdAt || '',
    updatedAt: user.updatedAt || '',
    requestedAt: user.requestedAt || '',
    approvedAt: user.approvedAt || '',
    blockedAt: user.blockedAt || '',
    history: Array.isArray(user.history) ? user.history : []
  };
}

function historyActor(from) {
  if (!from) return null;
  return {
    id: normalizeId(from.id),
    name: displayName(from, ''),
    username: from.username || ''
  };
}

function actionLabel(action) {
  if (action === 'requested') return "Ruxsat so'rovi yuborildi";
  if (action === 'approved') return 'Ruxsat berildi';
  if (action === 'blocked') return 'Foydalanish cheklandi';
  if (action === 'restored') return 'Qayta tiklandi';
  if (action === 'auto_approved_planned') return 'Rejalashtirilgan ruxsat bo\'yicha avtomatik ruxsat berildi';
  if (action === 'planned_permission_added') return 'Rejalashtirilgan ruxsat qo\'shildi';
  return action || 'Holat o\'zgardi';
}

function appendHistory(user, action, actor, note = '') {
  if (!Array.isArray(user.history)) user.history = [];
  const item = {
    at: new Date().toISOString(),
    action,
    note,
    actor: actor || null
  };
  user.history.push(item);
  if (user.history.length > 30) user.history = user.history.slice(-30);
  return item;
}

function formatHistoryDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('uz-UZ', {
    timeZone: HISTORY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatHistoryLine(item) {
  const actor = item.actor;
  const actorText = actor
    ? ` | Kim: ${actor.username ? '@' + actor.username : actor.name || 'Admin'} (${actor.id})`
    : '';
  const noteText = item.note ? ` | ${item.note}` : '';
  return `- ${formatHistoryDate(item.at)} - ${actionLabel(item.action)}${actorText}${noteText}`;
}

function normalizeUzPhone(raw) {
  const original = String(raw || '').trim();
  if (!original) return { ok: false, original, reason: "Bo'sh qiymat" };
  let digits = original.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 9) digits = '998' + digits;
  if (digits.length === 10 && digits.startsWith('0')) digits = '998' + digits.slice(1);
  if (!/^998\d{9}$/.test(digits)) {
    return { ok: false, original, reason: "O'zbekiston raqami formati emas" };
  }
  return { ok: true, original, phone: digits, display: formatUzPhone(digits) };
}

function formatUzPhone(digits) {
  const value = String(digits || '');
  if (!/^998\d{9}$/.test(value)) return value;
  return `+${value.slice(0, 3)} ${value.slice(3, 5)} ${value.slice(5, 8)} ${value.slice(8, 10)} ${value.slice(10, 12)}`;
}

function userPhoneKey(user) {
  const parsed = normalizeUzPhone(user && user.phone);
  return parsed.ok ? parsed.phone : '';
}

async function sendChannelLog(text) {
  if (!BOT_TOKEN || !HISTORY_CHANNEL_ID) return;
  await sendMessage(HISTORY_CHANNEL_ID, text, undefined)
    .catch(err => console.error(`History channel log failed: ${err.message}`));
}

async function sendHistoryLog(user, item) {
  if (!item) return;
  const actor = item.actor;
  const actorText = actor
    ? `${actor.username ? '@' + actor.username : actor.name || 'Noma\'lum'} (${actor.id})`
    : 'Tizim';
  const text = [
    '<b>Ruxsat tarixi</b>',
    `Vaqt: ${escapeHtml(formatHistoryDate(item.at))}`,
    `Amal: ${escapeHtml(actionLabel(item.action))}`,
    `Foydalanuvchi: ${escapeHtml(user.fullName || 'Nomsiz')}`,
    `Telefon: ${escapeHtml(formatUzPhone(userPhoneKey(user)) || user.phone || '-')}`,
    `Telegram ID: <code>${escapeHtml(user.id || user.telegramId || '-')}</code>`,
    user.username ? `Username: @${escapeHtml(user.username)}` : '',
    `Kim bajardi: ${escapeHtml(actorText)}`,
    item.note ? `Izoh: ${escapeHtml(item.note)}` : ''
  ].filter(Boolean).join('\n');
  await sendChannelLog(text);
}

async function upsertUserFromTelegram(telegramUser, patch = {}) {
  const db = await readDb();
  const id = normalizeId(telegramUser.id);
  let user = db.users.find(item => item.id === id);
  const now = new Date().toISOString();
  if (!user) {
    user = {
      id,
      telegramId: id,
      username: telegramUser.username || '',
      fullName: patch.fullName || displayName(telegramUser),
      phone: patch.phone || '',
      status: 'new',
      createdAt: now,
      updatedAt: now,
      requestedAt: '',
      history: []
    };
    db.users.push(user);
  }
  user.telegramId = id;
  user.username = telegramUser.username || user.username || '';
  user.fullName = patch.fullName !== undefined ? String(patch.fullName).trim() : (user.fullName || displayName(telegramUser));
  user.phone = patch.phone !== undefined ? String(patch.phone).trim() : (user.phone || '');
  user.updatedAt = now;
  await writeDb(db);
  return user;
}

async function getUser(userId) {
  const db = await readDb();
  return db.users.find(user => user.id === normalizeId(userId));
}

async function setUserStatus(userId, status, actor) {
  const allowed = new Set(['approved', 'blocked', 'pending', 'new']);
  if (!allowed.has(status)) throw new Error('Noto\'g\'ri status');
  const db = await readDb();
  const user = db.users.find(item => item.id === normalizeId(userId));
  if (!user) throw new Error('Foydalanuvchi topilmadi');
  const now = new Date().toISOString();
  const previousStatus = user.status || 'new';
  user.status = status;
  user.updatedAt = now;
  if (status === 'approved') user.approvedAt = now;
  if (status === 'blocked') user.blockedAt = now;
  let historyItem = null;
  if (previousStatus !== status) {
    const action = previousStatus === 'blocked' && status === 'approved' ? 'restored' : status;
    historyItem = appendHistory(user, action, historyActor(actor));
  }
  await writeDb(db);
  await sendHistoryLog(user, historyItem);
  return user;
}

async function requestAccess(telegramUser, patch = {}) {
  const user = await upsertUserFromTelegram(telegramUser, patch);
  if (user.status !== 'approved') {
    const alreadyPending = user.status === 'pending';
    const db = await readDb();
    const idx = db.users.findIndex(item => item.id === user.id);
    const dbUser = idx >= 0 ? db.users[idx] : user;
    const planned = findActivePlannedPermission(db, dbUser.phone);
    if (dbUser.status === 'blocked' && !planned) return dbUser;
    let historyItem = null;
    if (planned) {
      dbUser.status = 'approved';
      dbUser.requestedAt = new Date().toISOString();
      dbUser.approvedAt = dbUser.requestedAt;
      dbUser.updatedAt = dbUser.requestedAt;
      planned.active = false;
      planned.usedBy = dbUser.id;
      planned.usedAt = dbUser.updatedAt;
      historyItem = appendHistory(dbUser, 'auto_approved_planned', historyActor(telegramUser), `Telefon: ${formatUzPhone(planned.phone)}`);
      if (idx >= 0) db.users[idx] = dbUser;
      await writeDb(db);
      await sendHistoryLog(dbUser, historyItem);
      return dbUser;
    }

    dbUser.status = 'pending';
    dbUser.requestedAt = new Date().toISOString();
    dbUser.updatedAt = dbUser.requestedAt;
    if (!alreadyPending) historyItem = appendHistory(dbUser, 'requested', historyActor(telegramUser));
    if (idx >= 0) db.users[idx] = dbUser;
    await writeDb(db);
    await sendHistoryLog(dbUser, historyItem);
    await notifyAdmins(dbUser);
    return dbUser;
  }
  return user;
}

function isAdminId(id) {
  return ADMIN_IDS.has(normalizeId(id));
}

function adminHelpText(from) {
  return [
    'Bu bo\'lim faqat adminlar uchun.',
    `Sizning Telegram ID: <code>${escapeHtml(from.id)}</code>`,
    'Agar siz admin bo\'lsangiz, .env faylidagi ADMIN_IDS qatoriga shu ID ni yozing va serverni qayta ishga tushiring.'
  ].join('\n');
}

function findActivePlannedPermission(db, phone) {
  const parsed = normalizeUzPhone(phone);
  if (!parsed.ok) return null;
  return db.plannedPermissions.find(item => item.active && item.phone === parsed.phone) || null;
}

async function addPlannedPermissions(rawText, actor) {
  const parts = String(rawText || '').split(',').map(item => item.trim()).filter(Boolean);
  const result = { added: [], restored: [], duplicate: [], invalid: [] };
  if (parts.length === 0) {
    result.invalid.push({ original: rawText || '', reason: "Raqamlar topilmadi. Raqamlarni vergul bilan ajrating." });
    return result;
  }

  const db = await readDb();
  for (const part of parts) {
    const parsed = normalizeUzPhone(part);
    if (!parsed.ok) {
      result.invalid.push({ original: parsed.original || part, reason: parsed.reason });
      continue;
    }
    const existing = db.plannedPermissions.find(item => item.phone === parsed.phone);
    if (existing && existing.active) {
      result.duplicate.push(parsed.display);
      continue;
    }
    const now = new Date().toISOString();
    if (existing) {
      existing.active = true;
      existing.createdAt = now;
      existing.createdBy = historyActor(actor);
      existing.usedBy = '';
      existing.usedAt = '';
      result.restored.push(parsed.display);
    } else {
      db.plannedPermissions.push({
        phone: parsed.phone,
        display: parsed.display,
        active: true,
        createdAt: now,
        createdBy: historyActor(actor),
        usedBy: '',
        usedAt: ''
      });
      result.added.push(parsed.display);
    }
    await sendChannelLog([
      '<b>Rejalashtirilgan ruxsat qo\'shildi</b>',
      `Telefon: ${escapeHtml(parsed.display)}`,
      `Kim qo'shdi: ${escapeHtml(actor.username ? '@' + actor.username : displayName(actor, 'Admin'))} (<code>${escapeHtml(actor.id)}</code>)`,
      `Vaqt: ${escapeHtml(formatHistoryDate(now))}`
    ].join('\n'));
  }
  await writeDb(db);
  return result;
}

function plannedPermissionReport(result) {
  const lines = ['<b>Rejalashtirilgan ruxsatlar natijasi</b>'];
  if (result.added.length) {
    lines.push('', '<b>Qo\'shildi</b>', ...result.added.map(phone => `- ${escapeHtml(phone)}`));
  }
  if (result.restored.length) {
    lines.push('', '<b>Qayta faollashtirildi</b>', ...result.restored.map(phone => `- ${escapeHtml(phone)}`));
  }
  if (result.duplicate.length) {
    lines.push('', '<b>Oldin mavjud edi</b>', ...result.duplicate.map(phone => `- ${escapeHtml(phone)}`));
  }
  if (result.invalid.length) {
    lines.push('', '<b>Qo\'shilmadi</b>', ...result.invalid.map(item => `- ${escapeHtml(item.original)} — ${escapeHtml(item.reason)}`));
  }
  return lines.join('\n');
}

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN sozlanmagan');
  if (!initData) throw new Error('Telegram initData topilmadi');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new Error('Telegram hash topilmadi');
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculated = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const a = Buffer.from(calculated, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Telegram initData tasdiqlanmadi');
  }
  const user = JSON.parse(params.get('user') || '{}');
  if (!user.id) throw new Error('Telegram user topilmadi');
  return user;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(text);
}

function getAuthUser(req) {
  return verifyTelegramInitData(req.headers['x-telegram-init-data']);
}

async function handleApi(req, res, url) {
  try {
    const telegramUser = getAuthUser(req);
    const isAdmin = isAdminId(telegramUser.id);

    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = await upsertUserFromTelegram(telegramUser);
      sendJson(res, 200, { user: publicUser(user), telegramUser, isAdmin });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/profile') {
      const body = await readJson(req);
      const user = await upsertUserFromTelegram(telegramUser, {
        fullName: body.fullName,
        phone: body.phone
      });
      sendJson(res, 200, { user: publicUser(user), telegramUser, isAdmin });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/request-access') {
      const body = await readJson(req);
      const user = await requestAccess(telegramUser, {
        fullName: body.fullName,
        phone: body.phone
      });
      const status = user.status === 'blocked' ? 403 : 200;
      sendJson(res, status, { user: publicUser(user), telegramUser, isAdmin, error: user.status === 'blocked' ? 'Ruxsat bekor qilingan' : undefined });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/admin/users') {
      if (!isAdmin) {
        sendJson(res, 403, { error: 'Admin huquqi kerak' });
        return;
      }
      const db = await readDb();
      const users = db.users
        .filter(user => !isAdminId(user.id))
        .map(publicUser)
        .sort((a, b) => Date.parse(b.requestedAt || b.updatedAt || b.createdAt || 0) - Date.parse(a.requestedAt || a.updatedAt || a.createdAt || 0));
      sendJson(res, 200, { users });
      return;
    }

    const statusMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/status$/);
    if (req.method === 'POST' && statusMatch) {
      if (!isAdmin) {
        sendJson(res, 403, { error: 'Admin huquqi kerak' });
        return;
      }
      const body = await readJson(req);
      const user = await setUserStatus(decodeURIComponent(statusMatch[1]), body.status, telegramUser);
      await notifyUserAboutStatus(user);
      sendJson(res, 200, { user: publicUser(user) });
      return;
    }

    sendJson(res, 404, { error: 'API topilmadi' });
  } catch (err) {
    sendJson(res, 401, { error: err.message || 'So\'rov bajarilmadi' });
  }
}

async function serveIndex(res) {
  const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
  sendText(res, 200, html, 'text/html; charset=utf-8');
}

async function handleHttp(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    await handleApi(req, res, url);
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    await serveIndex(res);
    return;
  }
  sendText(res, 404, 'Not found');
}

async function botApi(method, payload) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN sozlanmagan');
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || method + ' failed');
  return data.result;
}

async function sendMessage(chatId, text, replyMarkup) {
  return botApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  });
}

async function editMessage(chatId, messageId, text, replyMarkup) {
  return botApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  });
}

async function answerCallback(callbackQueryId, text) {
  return botApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false
  });
}

function contactKeyboard() {
  return {
    keyboard: [[{ text: 'Telefon raqamni yuborish', request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true
  };
}

function requestReplyKeyboard() {
  return {
    keyboard: [[{ text: "Ruxsat so'rash" }]],
    resize_keyboard: true
  };
}

function removeKeyboard() {
  return { remove_keyboard: true };
}

function requestInlineKeyboard() {
  return {
    inline_keyboard: [[{ text: "Ruxsat so'rash", callback_data: 'request_access' }]]
  };
}

function miniAppKeyboard() {
  return {
    keyboard: [[{ text: 'Mini appni ochish', web_app: { url: WEBAPP_URL } }]],
    resize_keyboard: true
  };
}

function adminMainKeyboard() {
  return {
    keyboard: [
      [{ text: ADMIN_BUTTONS.users }],
      [{ text: ADMIN_BUTTONS.planned }],
      [{ text: ADMIN_BUTTONS.app, web_app: { url: WEBAPP_URL } }]
    ],
    resize_keyboard: true
  };
}

function adminDecisionKeyboard(userId) {
  return {
    inline_keyboard: [[
      { text: 'Ruxsat berish', callback_data: `admin:approved:${userId}` },
      { text: 'Bekor qilish', callback_data: `admin:blocked:${userId}` }
    ]]
  };
}

function adminUserKeyboard(user, includeBack = false) {
  const rows = [];
  if (user.status === 'approved') {
    rows.push([{ text: 'Foydalanishni cheklash', callback_data: `admin:blocked:${user.id}` }]);
  } else if (user.status === 'blocked') {
    rows.push([{ text: 'Qayta tiklash', callback_data: `admin:approved:${user.id}` }]);
  } else {
    rows.push([
      { text: 'Ruxsat berish', callback_data: `admin:approved:${user.id}` },
      { text: 'Bekor qilish', callback_data: `admin:blocked:${user.id}` }
    ]);
  }
  if (includeBack) rows.push([{ text: "Ro'yxatga qaytish", callback_data: 'admin:list' }]);
  return { inline_keyboard: rows };
}

function statusLabel(status) {
  if (status === 'approved') return 'Ruxsat berilgan';
  if (status === 'blocked') return 'Cheklangan';
  if (status === 'pending') return 'Tasdiq kutmoqda';
  return 'Yangi';
}

function adminUserText(user) {
  const lines = [
    user.status === 'pending' ? '<b>Yangi ruxsat so\'rovi</b>' : '<b>Foydalanuvchi</b>',
    `Ism familiyasi: ${escapeHtml(user.fullName || 'Nomsiz')}`,
    `Telefon raqami: ${escapeHtml(user.phone || '-')}`,
    `Telegram ID: <code>${escapeHtml(user.id)}</code>`,
    user.username ? `Username: @${escapeHtml(user.username)}` : '',
    '',
    `Holati: <b>${escapeHtml(statusLabel(user.status))}</b>`
  ];
  return lines.filter(line => line !== null && line !== undefined).join('\n');
}

function adminUsersListKeyboard(users) {
  const rows = users.slice(0, 80).map(user => {
    const name = user.fullName || user.username || user.phone || user.id;
    return [{ text: `${name} - ${statusLabel(user.status)}`, callback_data: `admin_select:${user.id}` }];
  });
  return { inline_keyboard: rows };
}

async function getManagedUsers() {
  const db = await readDb();
  return db.users
    .filter(user => !isAdminId(user.id))
    .sort((a, b) => Date.parse(b.requestedAt || b.updatedAt || b.createdAt || 0) - Date.parse(a.requestedAt || a.updatedAt || a.createdAt || 0));
}

function adminUsersSummaryText(users) {
  const approved = users.filter(user => user.status === 'approved').length;
  const blocked = users.filter(user => user.status === 'blocked').length;
  const pending = users.filter(user => user.status === 'pending').length;
  return [
    '<b>Barcha foydalanuvchilar</b>',
    `Jami: ${users.length}`,
    `Ruxsat berilgan: ${approved}`,
    `Tasdiq kutmoqda: ${pending}`,
    `Cheklangan: ${blocked}`,
    '',
    "Amal bajarish uchun bitta foydalanuvchini tanlang."
  ].join('\n');
}

async function sendAdminUsersList(chatId) {
  const users = await getManagedUsers();
  if (users.length === 0) {
    await sendMessage(chatId, 'Hali foydalanuvchilar yo\'q.', adminMainKeyboard());
    return;
  }
  await sendMessage(chatId, adminUsersSummaryText(users), adminUsersListKeyboard(users));
}

async function editAdminUsersList(chatId, messageId) {
  const users = await getManagedUsers();
  if (users.length === 0) {
    await editMessage(chatId, messageId, 'Hali foydalanuvchilar yo\'q.', { inline_keyboard: [] }).catch(() => {});
    return;
  }
  await editMessage(chatId, messageId, adminUsersSummaryText(users), adminUsersListKeyboard(users));
}

async function notifyAdmins(user) {
  if (!BOT_TOKEN) {
    console.error('Admin notify failed: BOT_TOKEN berilmagan');
    return;
  }
  if (ADMIN_IDS.size === 0) {
    console.error('Admin notify failed: ADMIN_IDS bo\'sh. Admin Telegram ID ni .env fayliga yozing.');
    return;
  }
  for (const adminId of ADMIN_IDS) {
    await sendMessage(adminId, adminUserText(user), adminUserKeyboard(user))
      .then(() => console.log(`Admin notify sent to ${adminId} for user ${user.id}`))
      .catch(err => console.error(`Admin notify failed for ADMIN_IDS=${adminId}: ${err.message}`));
  }
}

async function notifyUserAboutStatus(user) {
  if (!BOT_TOKEN || !user.telegramId) return;
  if (user.status === 'approved') {
    await sendMessage(user.telegramId, "Ruxsat berildi. Endi faqat Mini App orqali testlarni ishlashingiz mumkin.", miniAppKeyboard()).catch(() => {});
  }
  if (user.status === 'blocked') {
    await sendMessage(user.telegramId, "Ruxsat bekor qilindi. Test dasturidan foydalanish vaqtincha cheklangan.", removeKeyboard()).catch(() => {});
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function handleMessage(message) {
  const text = (message.text || '').trim();
  const from = message.from;
  const chatId = message.chat.id;

  if (text === '/start') {
    if (isAdminId(from.id)) {
      adminModes.delete(normalizeId(from.id));
      await upsertUserFromTelegram(from);
      await sendMessage(chatId, [
        'Admin rejimi yoqilgan.',
        'Pastdagi tugmalar orqali Mini Appni oching, userlar ro\'yxatini oling yoki rejalashtirilgan ruxsatlarni qo\'shing.',
        `Sizning Telegram ID: <code>${escapeHtml(from.id)}</code>`
      ].join('\n'), adminMainKeyboard());
      return;
    }
    const existing = await getUser(from.id);
    if (existing && existing.status === 'approved') {
      await sendMessage(chatId, "Sizga ruxsat berilgan. Mini Appni ochishingiz mumkin.", miniAppKeyboard());
      return;
    }
    if (existing && existing.status === 'pending') {
      await sendMessage(chatId, "So'rovingiz admin tasdig'ini kutmoqda. Ruxsat berilgandan keyin Mini App tugmasi chiqadi.", removeKeyboard());
      return;
    }
    if (existing && existing.status === 'blocked') {
      await sendMessage(chatId, "Ruxsat bekor qilingan. Administrator bilan bog'laning.", removeKeyboard());
      return;
    }
    await upsertUserFromTelegram(from);
    await sendMessage(chatId, "DAK Test botiga xush kelibsiz. Ro'yxatdan o'tish uchun Telegram telefon raqamingizni yuboring.", contactKeyboard());
    return;
  }

  if (text === '/id') {
    await sendMessage(chatId, `Sizning Telegram ID: <code>${escapeHtml(from.id)}</code>`);
    return;
  }

  if (isAdminId(from.id) && text === ADMIN_BUTTONS.users) {
    adminModes.delete(normalizeId(from.id));
    await sendAdminUsersList(chatId);
    return;
  }

  if (isAdminId(from.id) && text === ADMIN_BUTTONS.planned) {
    adminModes.set(normalizeId(from.id), 'planned_permissions');
    await sendMessage(chatId, [
      '<b>Rejalashtirilgan ruxsatlar</b>',
      'O\'zbekiston telefon raqamlarini vergul bilan ajratib yuboring.',
      '',
      'Namuna:',
      '<code>+998942203344, 942203344, +998 94 220 33 44, 94 220 33 44</code>'
    ].join('\n'), adminMainKeyboard());
    return;
  }

  if (isAdminId(from.id) && adminModes.get(normalizeId(from.id)) === 'planned_permissions') {
    const result = await addPlannedPermissions(text, from);
    adminModes.delete(normalizeId(from.id));
    await sendMessage(chatId, plannedPermissionReport(result), adminMainKeyboard());
    return;
  }

  if (text === '/admin') {
    if (!isAdminId(from.id)) {
      await sendMessage(chatId, adminHelpText(from), removeKeyboard());
      return;
    }
    adminModes.delete(normalizeId(from.id));
    await sendAdminUsersList(chatId);
    return;
  }

  if (text === '/app') {
    const user = await getUser(from.id);
    if (user && user.status === 'approved') {
      await sendMessage(chatId, 'Mini app tayyor.', miniAppKeyboard());
    } else {
      await sendMessage(chatId, "Avval test ishlash uchun ruxsat so'rang.", requestReplyKeyboard());
    }
    return;
  }

  if (text === '/status') {
    const user = await getUser(from.id);
    const status = user ? user.status : 'new';
    await sendMessage(chatId, `Joriy holat: <b>${escapeHtml(status)}</b>`);
    return;
  }

  if (message.contact) {
    if (message.contact.user_id && normalizeId(message.contact.user_id) !== normalizeId(from.id)) {
      await sendMessage(chatId, "Iltimos, faqat o'zingizning Telegram kontakt raqamingizni yuboring.");
      return;
    }
    await upsertUserFromTelegram(from, {
      fullName: displayName(from, [message.contact.first_name, message.contact.last_name].filter(Boolean).join(' ')),
      phone: message.contact.phone_number
    });
    await sendMessage(chatId, "Ro'yxatdan o'tdingiz. Endi test ishlash uchun adminga ruxsat so'rovi yuboring.", requestReplyKeyboard());
    return;
  }

  if (text.toLowerCase() === "ruxsat so'rash") {
    const existing = await getUser(from.id);
    if (!existing || !existing.phone) {
      await upsertUserFromTelegram(from);
      await sendMessage(chatId, "Avval Telegram telefon raqamingizni kontakt sifatida yuboring.", contactKeyboard());
      return;
    }
    const user = await requestAccess(from);
    if (user.status === 'blocked') {
      await sendMessage(chatId, "Ruxsat bekor qilingan. Administrator bilan bog'laning.", removeKeyboard());
    } else if (user.status === 'approved') {
      await sendMessage(chatId, 'Sizga ruxsat berilgan. Mini Appni ochishingiz mumkin.', miniAppKeyboard());
    } else {
      await sendMessage(chatId, "So'rov adminga yuborildi. Tasdiqlangandan keyin Mini App tugmasi chiqadi.", removeKeyboard());
    }
    return;
  }

  await sendMessage(chatId, "Buyruqlar: /start, /status, /app");
}

async function handleCallback(query) {
  const data = query.data || '';
  const from = query.from;

  if (data === 'request_access') {
    const existing = await getUser(from.id);
    if (!existing || !existing.phone) {
      await upsertUserFromTelegram(from);
      await answerCallback(query.id, 'Avval telefon raqam kerak');
      await sendMessage(from.id, "Avval Telegram telefon raqamingizni kontakt sifatida yuboring.", contactKeyboard());
      return;
    }
    const user = await requestAccess(from);
    await answerCallback(query.id, "So'rov yuborildi");
    if (user.status === 'blocked') {
      await sendMessage(from.id, "Ruxsat bekor qilingan. Administrator bilan bog'laning.", removeKeyboard());
    } else if (user.status === 'approved') {
      await sendMessage(from.id, 'Sizga ruxsat berilgan. Mini Appni ochishingiz mumkin.', miniAppKeyboard());
    } else {
      await sendMessage(from.id, "So'rov adminga yuborildi. Tasdiqdan keyin Mini App tugmasi chiqadi.", removeKeyboard());
    }
    return;
  }

  if (data === 'admin:list') {
    if (!isAdminId(from.id)) {
      await answerCallback(query.id, 'Admin huquqi kerak');
      return;
    }
    await answerCallback(query.id, "Ro'yxat yangilandi");
    if (query.message) {
      await editAdminUsersList(query.message.chat.id, query.message.message_id);
    }
    return;
  }

  const selectMatch = data.match(/^admin_select:(.+)$/);
  if (selectMatch) {
    if (!isAdminId(from.id)) {
      await answerCallback(query.id, 'Admin huquqi kerak');
      return;
    }
    const user = await getUser(selectMatch[1]);
    if (!user) {
      await answerCallback(query.id, 'Foydalanuvchi topilmadi');
      return;
    }
    await answerCallback(query.id, 'Foydalanuvchi tanlandi');
    if (query.message) {
      await editMessage(query.message.chat.id, query.message.message_id, adminUserText(user), adminUserKeyboard(user, true));
    }
    return;
  }

  const adminMatch = data.match(/^admin:(approved|blocked):(.+)$/);
  if (adminMatch) {
    if (!isAdminId(from.id)) {
      await answerCallback(query.id, 'Admin huquqi kerak');
      return;
    }
    const status = adminMatch[1];
    const userId = adminMatch[2];
    const user = await setUserStatus(userId, status, from);
    await notifyUserAboutStatus(user);
    await answerCallback(query.id, status === 'approved' ? 'Ruxsat berildi' : 'Foydalanish cheklandi');
    if (query.message) {
      await editMessage(query.message.chat.id, query.message.message_id, adminUserText(user), adminUserKeyboard(user, true))
        .catch(err => console.error('Admin message edit failed:', err.message));
    }
  }
}

async function handleUpdate(update) {
  if (update.message) await handleMessage(update.message);
  if (update.callback_query) await handleCallback(update.callback_query);
}

async function runBotPolling() {
  if (!BOT_TOKEN) {
    console.warn('BOT_TOKEN berilmagan. HTTP server ishlaydi, bot polling o\'chiq.');
    return;
  }
  let offset = 0;
  for (;;) {
    try {
      const updates = await botApi('getUpdates', { timeout: 25, offset, allowed_updates: ['message', 'callback_query'] });
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update).catch(err => console.error('Update failed:', err.message));
      }
    } catch (err) {
      console.error('Polling failed:', err.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

const server = http.createServer((req, res) => {
  handleHttp(req, res).catch(err => {
    console.error(err);
    sendJson(res, 500, { error: 'Server xatosi' });
  });
});

server.listen(PORT, () => {
  console.log(`Mini App server: http://localhost:${PORT}`);
  console.log(`WebApp URL: ${WEBAPP_URL}`);
  console.log(`Admin IDs loaded: ${ADMIN_IDS.size}`);
  if (ADMIN_IDS.size === 0) {
    console.warn('ADMIN_IDS bo\'sh. Admin xabar olishi uchun .env fayliga admin Telegram ID yozilishi kerak.');
  }
});

runBotPolling();
