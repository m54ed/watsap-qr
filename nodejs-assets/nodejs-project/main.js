'use strict';
/**
 * main.js — نقطة دخول Node داخل nodejs-mobile.
 * يربط واجهة React Native بمحرّك Baileys + المجدول عبر قناة rn-bridge.
 */

// polyfill حاسم: Node 18 داخل nodejs-mobile لا يوفّر globalThis.crypto
// (Web Crypto) الذي يحتاجه Baileys للتشفير — بدونه: «crypto is not defined».
try {
  const nodeCrypto = require('crypto');
  if (typeof globalThis.crypto === 'undefined' && nodeCrypto.webcrypto) {
    globalThis.crypto = nodeCrypto.webcrypto;
  }
} catch (_) {}

const rn_bridge = require('rn-bridge');
const store = require('./store');
const wa = require('./whatsapp');
const scheduler = require('./scheduler');

const dataDir = rn_bridge.app.datadir();

function send(obj) {
  try { rn_bridge.channel.send(JSON.stringify(obj)); } catch (_) {}
}
function emitEvent(event, payload) { send({ event, payload }); }

// حارس عام: يمنع أي خطأ غير معالَج من إسقاط نواة Node (يبقيها حيّة دائماً)
process.on('uncaughtException', (e) => {
  try { emitEvent('log', 'خطأ غير متوقّع: ' + (e && e.message)); } catch (_) {}
});
process.on('unhandledRejection', (e) => {
  try { emitEvent('log', 'رفض غير معالَج: ' + (e && (e.message || e))); } catch (_) {}
});

// تهيئة
store.init(dataDir);
wa.start({ dataDir, onEvent: (ev, data) => emitEvent(ev, data) });
scheduler.start((ev, data) => emitEvent(ev, data));

// معالجة أوامر الواجهة
rn_bridge.channel.on('message', async (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }
  const { id, cmd, args } = msg || {};
  const reply = (ok, data, error) => send({ rid: id, ok, data, error });
  try {
    switch (cmd) {
      case 'getState': return reply(true, wa.getState());
      case 'requestPairing': await wa.requestPairing(args); return reply(true, true);
      case 'logout': await wa.logout(); return reply(true, true);
      case 'fetchGroups': return reply(true, await wa.fetchGroups());

      case 'tasksList': return reply(true, store.Tasks.list());
      case 'taskAdd': store.Tasks.add(args); return reply(true, store.Tasks.list());
      case 'taskRemove': store.Tasks.remove(args); return reply(true, store.Tasks.list());
      case 'taskRetry': store.Tasks.retry(args); return reply(true, store.Tasks.list());

      case 'contactsList': return reply(true, store.Contacts.list());
      case 'contactAdd': store.Contacts.add(args.name, args.number, args.list); return reply(true, store.Contacts.list());
      case 'contactRemove': store.Contacts.remove(args); return reply(true, store.Contacts.list());

      case 'logsList': return reply(true, store.Logs.list());
      case 'logsStats': return reply(true, store.Logs.stats());
      case 'logsClear': store.Logs.clear(); return reply(true, true);

      case 'settingsGet': return reply(true, store.Settings.all());
      case 'settingsSet': store.Settings.set(args.key, args.value); return reply(true, store.Settings.all());

      default: return reply(false, null, 'أمر غير معروف: ' + cmd);
    }
  } catch (e) {
    reply(false, null, e.message);
  }
});

// إشعار الواجهة بأن Node جاهز
emitEvent('ready', true);
