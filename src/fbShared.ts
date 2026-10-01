/** fbShared.ts — أنواع وثوابت ودوال صافية مشتركة بين النشر اليدوي والتلقائي في فيسبوك. */

export type Group = { id: string; name: string; url: string; lastAt?: number };
export type Pending = { groupId: string; text: string };
export type Data = {
  variants: string[]; link: string; images: { uri: string; name: string }[];
  groups: Group[]; gap: keyof typeof GAPS; log: { group: string; at: number }[]; nextAt: number;
  pending: Pending | null; // محفوظ: لو أغلق أندرويد التطبيق وأنت في فيسبوك لا يضيع القروب المفتوح (منع نشر مكرر)
  postMode: 'manual' | 'auto';
};

export const DAY = 86400000;
export const DAILY_SOFT_LIMIT = 10;
// الفاصل العشوائي بين قروب وآخر (بالدقائق)
export const GAPS = {
  short: { label: 'قصير', hint: '2–5 د', min: 2, max: 5 },
  medium: { label: 'متوسط', hint: '5–12 د', min: 5, max: 12 },
  long: { label: 'طويل', hint: '12–25 د', min: 12, max: 25 },
} as const;
export const EMPTY: Data = { variants: [''], link: '', images: [], groups: [], gap: 'medium', log: [], nextAt: 0, pending: null, postMode: 'manual' };

export const rand = (min: number, max: number) => min + Math.random() * (max - min);
export const groupKey = (url: string) => (url.split('/groups/')[1] || '').split(/[/?#]/)[0].toLowerCase();

export const dueGroups = (d: Data, now: number) => d.groups.filter((g) => !g.lastAt || now - g.lastAt >= DAY);
export const postedToday = (d: Data, now: number) => d.log.filter((l) => now - l.at < DAY).length;

/** يختار قروباً مستحقاً عشوائياً وصياغة غير السابقة. null إن لا صياغات أو لا قروبات. */
export function pickJob(d: Data, now: number, lastVariant: { current: number }): (Pending & { group: Group }) | null {
  const variants = d.variants.map((v) => v.trim()).filter(Boolean);
  const due = dueGroups(d, now);
  if (!variants.length || !due.length) return null;
  const group = due[Math.floor(Math.random() * due.length)];
  let vi = Math.floor(Math.random() * variants.length);
  if (variants.length > 1 && vi === lastVariant.current) vi = (vi + 1) % variants.length; // لا تكرر نفس الصياغة مرتين متتاليتين
  lastVariant.current = vi;
  const text = variants[vi] + (d.link.trim() ? '\n\n' + d.link.trim() : '');
  return { groupId: group.id, text, group };
}

/** يسجّل النشر في القروب ويبدأ فاصلاً عشوائياً قبل التالي (تحديث صافٍ للبيانات). */
export function applyPosted(d: Data, groupId: string, at: number): Data {
  const g = d.groups.find((x) => x.id === groupId);
  return {
    ...d,
    groups: d.groups.map((x) => (x.id === groupId ? { ...x, lastAt: at } : x)),
    log: [{ group: g ? g.name : '?', at }].concat(d.log).slice(0, 200),
    nextAt: at + rand(GAPS[d.gap].min, GAPS[d.gap].max) * 60000,
    pending: null,
  };
}

/** رابط القروب على نسخة الجوال من فيسبوك (للمتصفح الداخلي). */
export const mobileUrl = (url: string) => 'https://m.facebook.com/groups/' + (url.split('/groups/')[1] || '').split(/[/?#]/)[0];
