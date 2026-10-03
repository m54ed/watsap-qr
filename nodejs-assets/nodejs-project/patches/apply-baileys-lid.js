'use strict';
/**
 * يرقّع Baileys 6.7.16 لدعم القروبات بنظام LID (يُشغَّل بعد npm install — محلياً وفي GitHub Actions).
 *
 * المشكلة: 6.7.16 يرمّز أجهزة أعضاء القروب دائماً بـ s.whatsapp.net، والقروبات الحديثة أعضاؤها بمعرّفات LID
 * ⇒ يبحث عن جلسة تشفير لـ «رقم» غير موجود ⇒ «No sessions» أو انتهاء المهلة، فيفشل الإرسال للقروب.
 * الإصلاح منقول كما هو من Baileys 6.7.24 (لا نستطيع الترقية: تتطلّب Node 20 ونواة الجوال Node 18):
 *   1) قراءة addressing_mode من بيانات القروب.  2) إرساله مع الرسالة.  3) ترميز الأجهزة بـ lid حين يكون القروب LID.
 * أي نص لا يُعثر عليه ⇒ يفشل البناء صراحةً بدل شحن نسخة غير مرقّعة.
 */
const fs = require('fs');
const path = require('path');

const lib = path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys', 'lib');
const MARK = '/* lid-patch */';

function patch(file, pairs) {
  const p = path.join(lib, file);
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes(MARK)) { console.log('already patched:', file); return; }
  for (const [from, to] of pairs) {
    const n = s.split(from).length - 1;
    if (n !== 1) throw new Error(`lid-patch: expected 1 match in ${file}, found ${n}:\n${from}`);
    s = s.replace(from, to);
  }
  fs.writeFileSync(p, MARK + '\n' + s);
  console.log('patched:', file);
}

patch('Socket/groups.js', [[
  '        id: groupId,\n',
  '        id: groupId,\n        addressingMode: group.attrs.addressing_mode,\n',
]]);

const GROUP_DOMAIN = "((groupData === null || groupData === void 0 ? void 0 : groupData.addressingMode) === 'lid' ? 'lid' : 's.whatsapp.net')";
patch('Socket/messages-send.js', [
  [
    '                    const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false);\n',
    "                    if (!isStatus) {\n" +
    "                        additionalAttributes = { ...additionalAttributes, addressing_mode: (groupData === null || groupData === void 0 ? void 0 : groupData.addressingMode) || 'pn' };\n" +
    "                    }\n" +
    '                    const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false);\n',
  ],
  [
    "devices.map(d => (0, WABinary_1.jidEncode)(d.user, isLid ? 'lid' : 's.whatsapp.net', d.device))",
    `devices.map(d => (0, WABinary_1.jidEncode)(d.user, ${GROUP_DOMAIN}, d.device))`,
  ],
  [
    "                    const jid = (0, WABinary_1.jidEncode)(user, isLid ? 'lid' : 's.whatsapp.net', device);\n                    if (!senderKeyMap[jid] || !!participant) {",
    `                    const jid = (0, WABinary_1.jidEncode)(user, ${GROUP_DOMAIN}, device);\n                    if (!senderKeyMap[jid] || !!participant) {`,
  ],
]);
