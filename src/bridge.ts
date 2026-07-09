/**
 * bridge.ts — جسر بين واجهة React Native ومحرّك Node (Baileys) عبر nodejs-mobile.
 * يوفّر استدعاءات وعديّة (request/response) بمعرّفات، واشتراكات للأحداث الحيّة.
 */
import nodejs from 'nodejs-mobile-react-native';

type Handler = (payload: any) => void;

let started = false;
let seq = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
const listeners = new Map<string, Set<Handler>>();

function handleMessage(raw: string) {
  let msg: any;
  try { msg = JSON.parse(raw); } catch { return; }

  if (msg.rid != null && pending.has(msg.rid)) {
    const p = pending.get(msg.rid)!;
    pending.delete(msg.rid);
    if (msg.ok) p.resolve(msg.data);
    else p.reject(new Error(msg.error || 'خطأ'));
    return;
  }
  if (msg.event) {
    const set = listeners.get(msg.event);
    if (set) set.forEach((h) => h(msg.payload));
  }
}

/** تشغيل محرّك Node مرة واحدة. */
export function startEngine() {
  if (started) return;
  started = true;
  nodejs.start('main.js');
  nodejs.channel.addListener('message', handleMessage);
}

/** إرسال أمر وانتظار الرد. */
export function call<T = any>(cmd: string, args?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = seq++;
    pending.set(id, { resolve, reject });
    nodejs.channel.send(JSON.stringify({ id, cmd, args }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('انتهت مهلة الاستجابة')); }
    }, 90000);
  });
}

/** الاشتراك في حدث حيّ (state / tasks:changed / logs:changed / ready). */
export function on(event: string, handler: Handler): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(handler);
  return () => listeners.get(event)?.delete(handler);
}
