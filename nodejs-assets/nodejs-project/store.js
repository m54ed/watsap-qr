'use strict';
/**
 * store.js — تخزين JSON محلي (بديل better-sqlite3 على nodejs-mobile).
 * يحفظ المهام والسجل والإعدادات وجهات الاتصال في مجلد بيانات التطبيق القابل للكتابة.
 */
const fs = require('fs');
const path = require('path');

let dir = null;
let data = { tasks: [], logs: [], settings: {}, contacts: [], seq: 1 };

function file() { return path.join(dir, 'wa-data.json'); }

function init(dataDir) {
  dir = dataDir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    if (fs.existsSync(file())) data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch (_) {}
  data.tasks = data.tasks || [];
  data.logs = data.logs || [];
  data.settings = data.settings || {};
  data.contacts = data.contacts || [];
  data.seq = data.seq || 1;
  if (data.settings.min_delay == null) data.settings.min_delay = '8';
  if (data.settings.max_delay == null) data.settings.max_delay = '20';
  save();
}

function save() {
  try { fs.writeFileSync(file(), JSON.stringify(data)); } catch (_) {}
}

const Settings = {
  all() { return { ...data.settings }; },
  get(k) { return data.settings[k]; },
  set(k, v) { data.settings[k] = String(v == null ? '' : v); save(); },
};

const Tasks = {
  list() { return data.tasks.slice().sort((a, b) => a.run_at - b.run_at); },
  due(now) {
    return data.tasks.filter((t) => t.run_at <= now &&
      (t.status === 'pending' || (t.status === 'failed' && t.attempts < 3)));
  },
  add(t) {
    const now = Date.now();
    const task = {
      id: data.seq++, title: t.title || '', kind: t.kind,
      targets: t.targets || [], body: t.body || '',
      media_path: t.media_path || null, media_type: t.media_type || null,
      run_at: t.run_at, repeat_type: t.repeat_type || 'none', repeat_every: t.repeat_every || 0,
      min_delay: t.min_delay ?? 8, max_delay: t.max_delay ?? 20,
      status: 'pending', attempts: 0, last_error: null, created_at: now, updated_at: now,
    };
    data.tasks.push(task); save(); return task;
  },
  find(id) { return data.tasks.find((t) => t.id === id); },
  setStatus(id, status, error) {
    const t = this.find(id); if (t) { t.status = status; t.last_error = error || null; t.updated_at = Date.now(); save(); }
  },
  incAttempt(id) { const t = this.find(id); if (t) { t.attempts++; t.updated_at = Date.now(); save(); } },
  reschedule(id, nextRunAt) {
    const t = this.find(id); if (t) { t.run_at = nextRunAt; t.status = 'pending'; t.last_error = null; t.updated_at = Date.now(); save(); }
  },
  retry(id) { const t = this.find(id); if (t) { t.status = 'pending'; t.attempts = 0; t.last_error = null; t.updated_at = Date.now(); save(); } },
  remove(id) { data.tasks = data.tasks.filter((t) => t.id !== id); save(); },
};

const Contacts = {
  list() { return data.contacts.slice(); },
  add(name, number, listName) {
    const n = String(number).replace(/[^\d]/g, '');
    if (n.length < 8) throw new Error('رقم غير صالح');
    data.contacts.push({ id: data.seq++, name: name || '', number: n, list_name: listName || 'عام' });
    save();
  },
  remove(id) { data.contacts = data.contacts.filter((c) => c.id !== id); save(); },
};

const Logs = {
  add(e) {
    data.logs.unshift({ task_id: e.task_id || null, title: e.title || '', target: e.target || '',
      ok: e.ok ? 1 : 0, error: e.error || null, at: Date.now() });
    if (data.logs.length > 500) data.logs.length = 500;
    save();
  },
  list(limit = 300) { return data.logs.slice(0, limit); },
  stats() {
    let sent = 0, failed = 0;
    for (const l of data.logs) l.ok ? sent++ : failed++;
    return { sent, failed, total: data.logs.length };
  },
  clear() { data.logs = []; save(); },
};

module.exports = { init, Settings, Tasks, Contacts, Logs };
