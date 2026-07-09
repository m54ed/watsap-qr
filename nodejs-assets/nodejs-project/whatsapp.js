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
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const b = await loadBaileys();
  const makeWASocket = b.default || b.makeWASocket;
  const { useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = b;
  const { state: authState, saveCreds: save } = await useMultiFileAuthState(authDir);
  saveCreds = save;

  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch (_) { version = undefined; }

  state = 'connecting';
  emit('state', getState());

  sock = makeWASocket({
    version, logger,
    auth: { creds: authState.creds, keys: makeCacheableSignalKeyStore(authState.keys, logger) },
    browser: ['WA Scheduler', 'Chrome', '1.0'],
    markOnlineOnConnect: false,
    syncFullHistory: true,
    keepAliveIntervalMs: 20000,
    connectTimeoutMs: 40000,
    retryRequestDelayMs: 1000,
  });

  sock.ev.on('creds.update', saveCreds);

  // ربط برمز (Pairing Code) — للربط على نفس الجوال بلا مسح QR
  if (pairPhone && !authState.creds.registered) {
    setTimeout(async () => {
      try {
        const num = String(pairPhone).replace(/[^\d]/g, '');
        pairingCode = await sock.requestPairingCode(num);
        state = 'pairing';
        emit('state', getState());
      } catch (e) {
        emit('state', { ...getState(), error: 'تعذّر إنشاء رمز الربط: ' + e.message });
      }
    }, 3000);
  }

  sock.ev.on('contacts.upsert', (c) => collectContacts(c));
  sock.ev.on('contacts.update', (c) => collectContacts(c));
  sock.ev.on('messaging-history.set', ({ contacts }) => collectContacts(contacts));

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { state = 'qr'; lastQr = qr; emit('state', getState()); }
    if (connection === 'open') {
      state = 'ready'; lastQr = null; pairPhone = null; pairingCode = null; emit('state', getState());
      setTimeout(() => {
        sock.resyncAppState(['critical_unblock_low', 'regular_high', 'regular_low', 'regular'], true).catch(() => {});
      }, 4000);
    }
    if (connection === 'close') {
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
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

/** طلب رمز ربط لرقم هاتف — يطلبه على الاتصال الحالي مباشرة (لا يُنهي السوكِت). */
async function requestPairing(number) {
  const num = String(number).replace(/[^\d]/g, '');
  pairPhone = num;
  pairingCode = null;
  if (!sock || state === 'ready') return; // بلا سوكِت أو متصل مسبقاً
  try {
    pairingCode = await sock.requestPairingCode(num);
    state = 'pairing';
    emit('state', getState());
  } catch (e) {
    emit('state', { ...getState(), error: 'تعذّر إنشاء رمز الربط: ' + e.message });
  }
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
