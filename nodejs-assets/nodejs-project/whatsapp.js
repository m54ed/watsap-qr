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
let pairingCode = null; // رمز الربط المُولّد (يطابق دائماً السوكِت الحيّ)
let appStateSynced = false;    // إعادة مزامنة حالة التطبيق مرة واحدة لكل جلسة (تجنّب إشعارات مزامنة متكرّرة)
const knownContacts = new Set();

async function loadBaileys() {
  if (BAILEYS) return BAILEYS;
  // إصلاح رمز الربط: getPlatformId في Baileys 6.7.16 يرسل رمز الحرف ('49') بدل رقم المنصة ('1')
  // في companion_platform_id، فيرفض واتساب الربط («تعذّر ربط الجهاز»). أُصلح في 6.7.17+، لكنها تتطلّب
  // Node 20 ونواة nodejs-mobile هي Node 18 — لذا نستبدل الدالة هنا. socket.js يقرؤها عبر getter حيّ.
  const generics = require('@whiskeysockets/baileys/lib/Utils/generics');
  const { proto } = require('@whiskeysockets/baileys/WAProto');
  generics.getPlatformId = (browser) => {
    const t = proto.DeviceProps.PlatformType[String(browser).toUpperCase()];
    return t ? t.toString() : '1'; // chrome
  };
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
  let { state: authState, saveCreds: save } = await useMultiFileAuthState(authDir);
  saveCreds = save;
  console.log('WA: auth loaded, registered=' + authState.creds.registered);

  // ملاحظة: لا نمسح الجلسة عند (me && !registered) — فهذه بالضبط حالة **نجاح المسح/الربط**
  // أثناء إعادة تشغيل 515 (restartRequired): الهوية مضبوطة والتسجيل لم يُثبَّت بعد.
  // مسحها هنا كان يدمّر كل ربط ناجح. التخلّص من الجلسة التالفة يتم عبر زر «امسح الرمز» أو 401/loggedOut.

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
    // اسم متصفح قياسي إلزامي: واتساب يرفض الربط برمز إذا كان companion_platform_display غير قياسي
    // (كان «Chrome (WA Scheduler)» ⇒ «تعذّر ربط الجهاز»). جُرّب فعلياً: «Chrome (Mac OS)» يربط بنجاح.
    browser: b.Browsers.macOS('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false, // لا تسحب كامل السجل — يوقف إشعارات «جارٍ/تمت المزامنة» المتكرّرة على الجوال
    keepAliveIntervalMs: 20000,
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 1000,
    qrTimeout: pairPhone ? 600000 : 120000, // وضع الربط: 10 دقائق ليبقى الرمز ثابتاً (لا يتغيّر قبل إدخاله)
  });

  sock.ev.on('creds.update', saveCreds);

  // ربط برمز (Pairing Code): كل سوكِت حيّ يرسل companion_hello ويحمل رمزه الصالح الخاص.
  // يجب توليد رمز جديد على **كل** سوكِت جديد ما دام غير مسجَّل — لأن رمز السوكِت الميت لا يعمل
  // («فشل الدخول»). الفحص !registered وحده يمنع طلب رمز بعد نجاح الدخول (إعادة اتصال 515).
  // يُطلب الرمز عند أول حدث qr (أي بعد pair-device من الخادم = السوكِت جاهز) لا بعد مؤقّت ثابت —
  // على شبكة جوال بطيئة كان المؤقّت يسبق المصافحة فيفشل الطلب بـ Connection Closed.
  let pairAsked = false;
  const askPairingCode = async () => {
    if (pairAsked || !pairPhone || authState.creds.registered) return;
    pairAsked = true;
    try {
      const num = String(pairPhone).replace(/[^\d]/g, '');
      const s = sock;
      const reply = waitPairingReply(s);
      const code = await s.requestPairingCode(num);
      // Baileys 6.7.16 يرسل الطلب بلا انتظار الرد ويعيد الرمز حتى لو رفضه الخادم — فننتظر الرد نحن
      // ولا نعرض رمزاً ميتاً (مثلاً 429 rate-overlimit بعد محاولات كثيرة).
      const err = await reply;
      if (err) throw new Error(err);
      if (sock !== s) return; // استُبدل السوكِت أثناء الانتظار
      pairingCode = code;
      state = 'pairing';
      emit('state', getState());
      console.log('WA: pairing code generated = ' + pairingCode + ' (live socket)');
    } catch (e) {
      console.log('WA: pairing request failed = ' + e.message);
      emit('state', { ...getState(), error: 'تعذّر إنشاء رمز الربط: ' + e.message });
    }
  };

  sock.ev.on('contacts.upsert', (c) => collectContacts(c));
  sock.ev.on('contacts.update', (c) => collectContacts(c));
  sock.ev.on('messaging-history.set', ({ contacts }) => collectContacts(contacts));

  console.log('WA: socket created, waiting for connection.update');
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    console.log('WA: connection.update conn=' + connection + ' qr=' + (qr ? 'YES' : 'no'));
    if (qr && pairPhone) askPairingCode();
    if (qr && !pairPhone) {
      // نولّد صورة QR (data URL) في Node — تُعرض كـ Image في الواجهة (بلا مكتبة SVG تحتاج TextEncoder)
      try { lastQr = await require('qrcode').toDataURL(qr, { margin: 1, width: 300 }); }
      catch (_) { lastQr = qr; }
      state = 'qr'; emit('state', getState());
    }
    if (connection === 'open') {
      state = 'ready'; lastQr = null; pairPhone = null; pairingCode = null; emit('state', getState());
      // إعادة مزامنة حالة التطبيق (لجلب جهات الحالة) **مرة واحدة فقط** — لا تُكرَّر في كل اتصال
      if (!appStateSynced) {
        appStateSynced = true;
        setTimeout(() => {
          sock.resyncAppState(['critical_unblock_low', 'regular_high', 'regular_low', 'regular'], true).catch(() => {});
        }, 4000);
      }
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

/** ينتظر رد الخادم على companion_hello: null عند القبول، أو رسالة خطأ مفهومة عند الرفض. */
function waitPairingReply(s) {
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(timer); s.ws.off('frame', onFrame); resolve(v); };
    const onFrame = (f) => {
      if (!f || f.tag !== 'iq') return;
      const kids = Array.isArray(f.content) ? f.content : [];
      if (f.attrs.type === 'result' && kids.some((c) => c.tag === 'link_code_companion_reg')) return done(null);
      if (f.attrs.type === 'error') {
        const e = kids.find((c) => c.tag === 'error');
        const code = e && e.attrs.code;
        if (code === '429') return done('واتساب أوقف طلبات الربط مؤقتاً لكثرة المحاولات (429). انتظر ساعة تقريباً ثم أعد المحاولة.');
        return done('رفض واتساب طلب الربط (' + (code || '?') + ' ' + ((e && e.attrs.text) || '') + ').');
      }
    };
    const timer = setTimeout(() => done(null), 8000); // لا رد خلال المهلة: اعرض الرمز كما كان سابقاً
    s.ws.on('frame', onFrame);
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
let lastPairReq = 0;
async function requestPairing(number) {
  const num = String(number).replace(/[^\d]/g, '');
  const now = Date.now();
  // debounce: تجاهل أي استدعاء مكرّر خلال 6 ثوانٍ لنفس الرقم — يمنع سوكِتين متنافسين
  // (سبب رفض واتساب «تعذر ربط الجهاز») سواء جاء الازدواج من نقرة مزدوجة أو من الجسر.
  if (num === pairPhone && (now - lastPairReq) < 6000) {
    console.log('WA: requestPairing IGNORED (debounced duplicate)');
    return;
  }
  lastPairReq = now;
  pairPhone = num;
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
  if (target.isGroup) {
    // قروب «المشرفون فقط يرسلون»: الخادم يرفض الرسالة — نتخطاه برسالة واضحة بدل فشل غامض أو مهلة
    const meta = await withTimeout(sock.groupMetadata(jid), 25000, 'تعذّر جلب بيانات القروب');
    if (meta.announce && !isAdmin(meta)) throw new Error('🔒 القروب مقفل — المشرفون فقط يرسلون فيه. تخطّيته.');
  }
  const content = buildContent(body, mediaPath, mediaType);
  await simulateTyping(jid, body);
  // القروبات الكبيرة تحتاج وقتاً لتشفير الرسالة لكل الأعضاء — مهلة أطول حتى لا تُعدّ فشلاً
  const limit = target.isGroup ? 90000 : 45000;
  try { await withTimeout(sock.sendMessage(jid, content), limit, 'تعذّر الإرسال'); }
  catch (e) { if (/انتهت المهلة/.test(e.message)) forceReconnect(); throw e; }
}

/** هل حسابي مشرف في القروب؟ (يقارن برقمي وبمعرّف LID لأن القروبات الحديثة تستخدمه) */
function isAdmin(meta) {
  const norm = BAILEYS.jidNormalizedUser;
  const me = [sock.user && sock.user.id, sock.user && sock.user.lid].filter(Boolean).map(norm);
  return (meta.participants || []).some((p) => p.admin && me.includes(norm(p.id)));
}

/** «يكتب…» لمدة تناسب طول النص (2–8 ث مع عشوائية) قبل الإرسال — سلوك أقرب للإنسان. فشلها لا يمنع الإرسال. */
async function simulateTyping(jid, body) {
  const ms = Math.min(8000, 2000 + String(body || '').length * 40) * (0.7 + Math.random() * 0.6);
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise((r) => setTimeout(r, ms));
    await sock.sendPresenceUpdate('paused', jid);
  } catch (_) {}
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
  return Object.values(groups || {}).map((g) => ({
    group_id: g.id, name: g.subject || '',
    locked: !!g.announce && !isAdmin(g), // «المشرفون فقط يرسلون» وأنا لست مشرفاً
  }));
}

async function logout() {
  stopping = true;
  try { if (sock) await sock.logout(); } catch (_) {}
  try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (_) {}
  // ألغِ وضع الربط برمز أيضاً — وإلا يعود للربط بدل عرض QR ويعلق على «جاري التحضير»
  pairPhone = null; pairingCode = null;
  sock = null; state = 'disconnected'; lastQr = null; appStateSynced = false;
  emit('state', getState());
  stopping = false;
  scheduleReconnect(1000);
}

module.exports = { start, getState, sendMessageTo, postStatus, fetchGroups, logout, requestPairing };
