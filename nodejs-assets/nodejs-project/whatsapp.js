'use strict';
/**
 * whatsapp.js — غلاف Baileys لنسخة أندرويد (يعمل داخل nodejs-mobile).
 * نفس منطق نسخة الديسكتوب + إصلاح الخمول (keep-alive + مهلة إرسال + إعادة اتصال).
 */
const fs = require('fs');
const path = require('path');

let BAILEYS = null;
let sock = null;
let saveCreds = null;
let authDir = null;
let logger = null;

let state = 'disconnected'; // disconnected | qr | connecting | ready | pairing
let lastQr = null;
let emit = () => {};
let stopping = false;
let reconnectTimer = null;
let pairPhone = null;   // رقم الهاتف عند الربط برمز (نفس الجوال)
let pairingCode = null; // رمز الربط المُولّد
const knownContacts = new Set();

async function loadBaileys() {
  if (BAILEYS) return BAILEYS;
  BAILEYS = require('@whiskeysockets/baileys');
  return BAILEYS;
}

function collectContacts(list) {
  for (const c of list || []) {
    const id = c && (c.id || c.jid);
    if (id && String(id).endsWith('@s.whatsapp.net')) knownContacts.add(id);
  }
}

function scheduleReconnect(delay) {
  if (stopping || reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect().catch(() => {}); }, delay);
}

function guessMime(fp) {
  const e = path.extname(fp).toLowerCase();
  return ({ '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.png': 'image/png' })[e] || 'application/octet-stream';
}

function buildContent(body, mediaPath, mediaType) {
  if (!mediaPath) { if (!body) throw new Error('الرسالة فارغة.'); return { text: body }; }
  if (!fs.existsSync(mediaPath)) throw new Error('ملف الوسائط غير موجود.');
  const buffer = fs.readFileSync(mediaPath);
  const caption = body || '';
  if (mediaType === 'image') return { image: buffer, caption };
  if (mediaType === 'video') return { video: buffer, caption };
  return { document: buffer, mimetype: guessMime(mediaPath), fileName: path.basename(mediaPath), caption };
}

async function connect() {
  console.log('WA: connect() start');
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const b = await loadBaileys();
  const makeWASocket = b.default || b.makeWASocket;
  const { useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = b;
  const { state: authState, saveCreds: save } = await useMultiFileAuthState(authDir);
  saveCreds = save;
  console.log('WA: auth loaded, registered=' + authState.creds.registered);

  // أحدث نسخة واتساب-ويب بمهلة (لازمة لتفادي رفض 405، وبمهلة لتفادي التعلّق)
  let version;
  try {
    const r = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000)),
    ]);
    version = r.version;
    console.log('WA: WA-web version ' + JSON.stringify(version));
  } catch (e) { version = undefined; console.log('WA: version fetch failed: ' + e.message); }

  state = 'connecting';
  emit('state', getState());

  sock = makeWASocket({
    version, logger,
    auth: { creds: authState.creds, keys: makeCacheableSignalKeyStore(authState.keys, logger) },
    browser: ['WA Scheduler', 'Chrome', '1.0'],
    markOnlineOnConnect: false,
    syncFullHistory: true,
    keepAliveIntervalMs: 20000,
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 1000,
    qrTimeout: 120000, // يبقي رمز الربط/QR صالحاً مدة أطول (يقلّل تكرار الاتصال الذي يُبطِل الرمز)
  });

  sock.ev.on('creds.update', saveCreds);

  // ربط برمز (Pairing Code) — للربط على نفس الجوال بلا مسح QR (على هذا السوكِت الجديد)
  if (pairPhone && !authState.creds.registered) {
    setTimeout(async () => {
      try {
        const num = String(pairPhone).replace(/[^\d]/g, '');
        pairingCode = await sock.requestPairingCode(num);
        state = 'pairing';
        emit('state', getState());
        console.log('WA: pairing code generated = ' + pairingCode);
      } catch (e) {
        console.log('WA: pairing request failed = ' + e.message);
        emit('state', { ...getState(), error: 'تعذّر إنشاء رمز الربط: ' + e.message });
      }
    }, 4000);
  }

  sock.ev.on('contacts.upsert', (c) => collectContacts(c));
  sock.ev.on('contacts.update', (c) => collectContacts(c));
  sock.ev.on('messaging-history.set', ({ contacts }) => collectContacts(contacts));

  console.log('WA: socket created, waiting for connection.update');
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    console.log('WA: connection.update conn=' + connection + ' qr=' + (qr ? 'YES' : 'no'));
    if (qr && !pairPhone) {
      // نولّد صورة QR (data URL) في Node — تُعرض كـ Image في الواجهة (بلا مكتبة SVG تحتاج TextEncoder)
      try { lastQr = await require('qrcode').toDataURL(qr, { margin: 1, width: 300 }); }
      catch (_) { lastQr = qr; }
      state = 'qr'; emit('state', getState());
    }
    if (connection === 'open') {
      state = 'ready'; lastQr = null; pairPhone = null; pairingCode = null; emit('state', getState());
      setTimeout(() => {
        sock.resyncAppState(['critical_unblock_low', 'regular_high', 'regular_low', 'regular'], true).catch(() => {});
      }, 4000);
    }
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      console.log('WA: CLOSE code=' + code + ' err=' + (lastDisconnect && lastDisconnect.error && lastDisconnect.error.message));
      if (code === b.DisconnectReason.loggedOut) {
        state = 'disconnected'; lastQr = null;
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (_) {}
        emit('state', { ...getState(), error: 'انتهت الجلسة. امسح رمز QR من جديد.' });
        scheduleReconnect(1500);
      } else {
        state = 'connecting';
        emit('state', { ...getState(), error: 'انقطع الاتصال، تُعاد المحاولة…' });
        scheduleReconnect(3000);
      }
    }
  });
}

async function start({ dataDir, onEvent }) {
  emit = onEvent || emit;
  stopping = false;
  authDir = path.join(dataDir, 'baileys_auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
  logger = require('pino')({ level: 'silent' });
  try { await connect(); }
  catch (e) { state = 'disconnected'; emit('state', { ...getState(), error: 'تعذّر البدء: ' + e.message }); }
}

function getState() { return { state, qr: lastQr, pairingCode }; }

/**
 * طلب رمز ربط لرقم هاتف. يجب توليد الرمز على سوكِت **جديد** (وإلا «فشل الدخول»)،
 * لذا نُغلق سوكِت QR الحالي ونعيد الاتصال بسوكِت نظيف يطلب الرمز في connect().
 */
async function requestPairing(number) {
  pairPhone = String(number).replace(/[^\d]/g, '');
  pairingCode = null;
  state = 'connecting';
  emit('state', getState());
  console.log('WA: requestPairing -> fresh socket for ' + pairPhone);
  try {
    if (sock) {
      sock.ev.removeAllListeners('connection.update'); // امنع إعادة اتصال مزدوجة من السوكِت القديم
      try { if (sock.ws) sock.ws.close(); } catch (_) {}
    }
  } catch (_) {}
  sock = null;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  connect().catch((e) => console.log('WA: pair reconnect err ' + e.message));
}

function assertReady() { if (!sock || state !== 'ready') throw new Error('واتساب غير متصل.'); }

function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(label + ' — انتهت المهلة')), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

function forceReconnect() {
  state = 'connecting'; emit('state', { ...getState(), error: 'اكتُشف خمول — تُعاد المحاولة…' });
  try { if (sock) sock.end(new Error('idle')); } catch (_) {}
  scheduleReconnect(2500);
}

async function resolveJid(number) {
  const digits = String(number).replace(/[^\d]/g, '');
  const results = await sock.onWhatsApp(digits);
  const hit = results && results[0];
  if (!hit || !hit.exists) throw new Error('الرقم غير مسجّل في واتساب: ' + number);
  return hit.jid;
}

async function sendMessageTo(target, body, mediaPath, mediaType) {
  assertReady();
  const jid = target.isGroup ? String(target.id)
    : await withTimeout(resolveJid(target.number || target.id), 25000, 'تعذّر التحقق من الرقم');
  const content = buildContent(body, mediaPath, mediaType);
  try { await withTimeout(sock.sendMessage(jid, content), 45000, 'تعذّر الإرسال'); }
  catch (e) { if (/انتهت المهلة/.test(e.message)) forceReconnect(); throw e; }
}

async function postStatus(body, mediaPath, mediaType, audienceNumbers) {
  assertReady();
  const content = buildContent(body, mediaPath, mediaType);
  const set = new Set();
  for (const n of audienceNumbers || []) { const d = String(n).replace(/[^\d]/g, ''); if (d) set.add(d + '@s.whatsapp.net'); }
  for (const jid of knownContacts) set.add(jid);
  const statusJidList = Array.from(set);
  if (!statusJidList.length) throw new Error('لا توجد جهات لعرض الحالة عليها. أضف أشخاصاً.');
  try {
    await withTimeout(sock.sendMessage('status@broadcast', content,
      { backgroundColor: '#0b8043', font: 3, statusJidList, broadcast: true }), 60000, 'تعذّر نشر الحالة');
  } catch (e) { if (/انتهت المهلة/.test(e.message)) forceReconnect(); throw e; }
  return statusJidList.length;
}

async function fetchGroups() {
  assertReady();
  const groups = await sock.groupFetchAllParticipating();
  return Object.values(groups || {}).map((g) => ({ group_id: g.id, name: g.subject || '' }));
}

async function logout() {
  stopping = true;
  try { if (sock) await sock.logout(); } catch (_) {}
  try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (_) {}
  sock = null; state = 'disconnected'; lastQr = null;
  emit('state', getState());
  stopping = false;
  scheduleReconnect(1000);
}

module.exports = { start, getState, sendMessageTo, postStatus, fetchGroups, logout, requestPairing };
