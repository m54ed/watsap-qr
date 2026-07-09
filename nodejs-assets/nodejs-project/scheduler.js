'use strict';
/**
 * scheduler.js — محرك الطابور (نبضة كل دقيقة عبر setInterval).
 * ينفّذ المهام المستحقة عبر Baileys مع فاصل عشوائي، ويعالج التكرار.
 */
const store = require('./store');
const wa = require('./whatsapp');

let running = false;
let emit = () => {};
let timer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function applyVars(text, target) {
  if (!text) return text;
  const name = (target && target.name) || '';
  return text.replace(/\{\s*(?:الاسم|اسم|name)\s*\}/gi, name);
}

function nextRun(t) {
  const base = Date.now();
  switch (t.repeat_type) {
    case 'hourly': return base + 3600000;
    case 'daily': return base + 86400000;
    case 'weekly': return base + 7 * 86400000;
    case 'interval': return base + Math.max(1, t.repeat_every) * 3600000;
    default: return null;
  }
}

async function runTask(t) {
  store.Tasks.setStatus(t.id, 'running');
  store.Tasks.incAttempt(t.id);
  emit('tasks:changed');
  const minD = (t.min_delay ?? 8) * 1000, maxD = (t.max_delay ?? 20) * 1000;
  let ok = 0, fail = 0;
  try {
    if (t.kind === 'status') {
      const audience = store.Contacts.list().map((c) => c.number);
      const viewers = await wa.postStatus(t.body, t.media_path, t.media_type, audience);
      store.Logs.add({ task_id: t.id, title: t.title, target: `حالة (${viewers} مشاهد)`, ok: true });
      ok++;
    } else {
      const targets = t.targets || [];
      if (!targets.length) throw new Error('لا يوجد مستلمون.');
      for (let i = 0; i < targets.length; i++) {
        const tg = targets[i];
        try {
          await wa.sendMessageTo(tg, applyVars(t.body, tg), t.media_path, t.media_type);
          store.Logs.add({ task_id: t.id, title: t.title, target: tg.name || tg.number || tg.id, ok: true });
          ok++;
        } catch (err) {
          store.Logs.add({ task_id: t.id, title: t.title, target: tg.name || tg.number || tg.id, ok: false, error: err.message });
          fail++;
        }
        emit('logs:changed');
        if (i < targets.length - 1) await sleep(rand(minD, maxD));
      }
    }
    const final = fail === 0 ? 'done' : (ok === 0 ? 'failed' : 'partial');
    const next = nextRun(t);
    if (next && final !== 'failed') store.Tasks.reschedule(t.id, next);
    else store.Tasks.setStatus(t.id, final, fail ? `فشل ${fail} من ${ok + fail}` : null);
  } catch (err) {
    store.Logs.add({ task_id: t.id, title: t.title, target: t.kind === 'status' ? 'حالة' : 'مهمة', ok: false, error: err.message });
    store.Tasks.setStatus(t.id, 'failed', err.message);
  }
  emit('tasks:changed'); emit('logs:changed');
}

async function tick() {
  if (running) return;
  running = true;
  try {
    for (const t of store.Tasks.due(Date.now())) {
      if (wa.getState().state !== 'ready') break;
      await runTask(t);
    }
  } catch (_) {} finally { running = false; }
}

function start(onEvent) {
  emit = onEvent || emit;
  timer = setInterval(tick, 60000);
  setTimeout(tick, 10000);
}

module.exports = { start };
