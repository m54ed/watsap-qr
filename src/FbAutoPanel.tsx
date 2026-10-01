/**
 * FbAutoPanel.tsx — النشر التلقائي في قروبات فيسبوك عبر متصفح داخلي (WebView) بحساب المستخدم.
 * المستخدم يسجّل دخوله بنفسه داخل المتصفح. الأتمتة: فتح القروب ← «اكتب شيئاً» ← كتابة النص ← «نشر» ← تحقق،
 * بتأخيرات بشرية عشوائية، وفاصل عشوائي بين القروبات، وحد يومي. أي خطوة تفشل ⇒ يتوقف ويترك الإكمال للمستخدم.
 * يعمل والتطبيق مفتوح فقط (أندرويد يوقف المتصفح الداخلي في الخلفية).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { C } from './theme';
import { Data, DAILY_SOFT_LIMIT, rand, pickJob, applyPosted, postedToday, mobileUrl, Pending } from './fbShared';
import { probeScript, openComposerScript, fillScript, postScript, verifyScript } from './fbAutoScripts';

type Props = {
  data: Data;
  setData: (d: Data) => void;
  lastVariant: { current: number };
};
type Phase = 'idle' | 'loading' | 'probe' | 'openComposer' | 'fill' | 'post' | 'verify';

const HOME = 'https://m.facebook.com/';
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const STEP_TIMEOUT = 25000;

export default function FbAutoPanel({ data, setData, lastVariant }: Props) {
  const web = useRef<WebView>(null);
  const [url, setUrl] = useState(HOME);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('اضغط «تسجيل الدخول» أول مرة، ثم «تشغيل تلقائي».');
  const [log, setLog] = useState<string[]>([]);
  const [, tick] = useState(0);

  const runningRef = useRef(false);
  const phase = useRef<Phase>('idle');
  const job = useRef<(Pending & { name: string }) | null>(null);
  const dataRef = useRef(data);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const stepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fillTries = useRef(0);
  useEffect(() => { dataRef.current = data; }, [data]);

  // تحديث البيانات فوراً في المرجع (الخطوات التالية تقرأه قبل أن يُعاد الرسم)
  const commit = useCallback((fn: (d: Data) => Data) => {
    const nd = fn(dataRef.current); dataRef.current = nd; setData(nd);
  }, [setData]);
  const addLog = (s: string) => setLog((l) => [new Date().toLocaleTimeString('ar') + ' · ' + s].concat(l).slice(0, 8));
  const later = (ms: number, fn: () => void) => { timers.current.push(setTimeout(fn, ms)); };
  const clearAll = () => {
    timers.current.forEach(clearTimeout); timers.current = [];
    if (stepTimer.current) clearTimeout(stepTimer.current); stepTimer.current = null;
  };
  useEffect(() => () => clearAll(), []);
  // عدّاد الانتظار المعروض
  useEffect(() => { if (!running) return; const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, [running]);

  const stop = useCallback((why: string) => {
    runningRef.current = false; setRunning(false); clearAll(); phase.current = 'idle';
    setStatus(why);
  }, []);

  const fail = useCallback((info: string) => {
    const name = job.current ? job.current.name : '';
    addLog('⚠️ ' + name + ': ' + info);
    stop('⚠️ توقّف في «' + name + '»: ' + info + '\nأكمل النشر يدوياً في المتصفح ثم اضغط «✓ نشرت»، أو «تخطَّ».');
  }, [stop]);

  const inject = (p: Phase, script: string) => {
    if (!runningRef.current) return;
    phase.current = p;
    if (stepTimer.current) clearTimeout(stepTimer.current);
    stepTimer.current = setTimeout(() => fail('الصفحة ما ردّت (انتهت المهلة)'), STEP_TIMEOUT);
    web.current?.injectJavaScript(script);
  };

  const runNext = useCallback(() => {
    if (!runningRef.current) return;
    const d = dataRef.current, now = Date.now();
    if (postedToday(d, now) >= DAILY_SOFT_LIMIT) return stop(`✅ وصلت الحد اليومي (${DAILY_SOFT_LIMIT} منشورات). أكمل بكرة.`);
    if (d.nextAt > now) {
      setStatus('⏳ فاصل عشوائي قبل القروب التالي…');
      later(d.nextAt - now + 1000, runNext);
      return;
    }
    const j = pickJob(d, now, lastVariant);
    if (!j) return stop(d.variants.some((v) => v.trim()) ? '✅ نشرت في كل القروبات خلال آخر 24 ساعة.' : 'اكتب صياغة للمنشور أولاً (تبويب المنشور).');
    job.current = { groupId: j.groupId, text: j.text, name: j.group.name };
    commit((x) => ({ ...x, pending: { groupId: j.groupId, text: j.text } }));
    phase.current = 'loading';
    setStatus('🌐 فتح «' + j.group.name + '»…');
    if (stepTimer.current) clearTimeout(stepTimer.current);
    stepTimer.current = setTimeout(() => fail('الصفحة ما فتحت'), 45000);
    setUrl(mobileUrl(j.group.url) + '?_=' + now); // ?_ يجبر إعادة التحميل
  }, [commit, fail, lastVariant, stop]);

  const onLoadEnd = () => {
    if (!runningRef.current) return;
    // «اكتب شيئاً» قد ينقل لصفحة محرّر جديدة — سكربت الكتابة المحقون قبل التنقل يضيع، فنعيده بعد التحميل
    if ((phase.current === 'openComposer' || phase.current === 'fill') && job.current) {
      const text = job.current.text;
      fillTries.current = 0;
      later(rand(2000, 3500), () => inject('fill', fillScript(text)));
      return;
    }
    if (phase.current !== 'loading') return;
    phase.current = 'probe';
    later(rand(3000, 6000), () => inject('probe', probeScript()));
  };

  const onMessage = (e: WebViewMessageEvent) => {
    let m: any; try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (!runningRef.current || m.step !== phase.current) return; // رد متأخر من خطوة سابقة — تجاهله
    if (stepTimer.current) { clearTimeout(stepTimer.current); stepTimer.current = null; }
    const j = job.current!;
    switch (m.step) {
      case 'probe':
        if (!m.loggedIn) {
          commit((x) => ({ ...x, pending: null })); // لم يبدأ أي نشر — لا تعرض «✓ نشرت»
          return stop('🔑 لست مسجّل دخول. اضغط «تسجيل الدخول» وسجّل بحسابك ثم «تشغيل تلقائي».');
        }
        if (!m.member) {
          addLog('↷ لست عضواً في «' + j.name + '» — تخطّيته اليوم');
          commit((x) => ({ ...x, pending: null, groups: x.groups.map((g) => (g.id === j.groupId ? { ...g, lastAt: Date.now() } : g)) }));
          return later(rand(5000, 10000), runNext);
        }
        setStatus('✍️ فتح محرّر المنشور في «' + j.name + '»…');
        return later(rand(2000, 4000), () => inject('openComposer', openComposerScript()));
      case 'openComposer':
        if (!m.ok) return fail(m.info);
        fillTries.current = 0;
        return later(rand(3000, 5000), () => inject('fill', fillScript(j.text)));
      case 'fill':
        if (!m.ok) {
          if (++fillTries.current < 3) return later(2000, () => inject('fill', fillScript(j.text)));
          return fail(m.info);
        }
        setStatus('📤 نشر في «' + j.name + '»…');
        return later(rand(2000, 4000), () => inject('post', postScript()));
      case 'post':
        if (!m.ok) return fail(m.info);
        return later(8000, () => inject('verify', verifyScript(j.text)));
      case 'verify':
        if (!m.ok) return fail(m.info);
        commit((x) => applyPosted(x, j.groupId, Date.now()));
        addLog('✓ نُشر في «' + j.name + '»');
        phase.current = 'idle';
        return later(1000, runNext);
    }
  };

  function start() {
    const d = dataRef.current;
    if (postedToday(d, Date.now()) >= DAILY_SOFT_LIMIT) return Alert.alert('الحد اليومي', `نشرت ${DAILY_SOFT_LIMIT} منشورات خلال 24 ساعة. أكمل بكرة.`);
    runningRef.current = true; setRunning(true);
    addLog('▶ بدأ التشغيل التلقائي');
    runNext();
  }

  const pendingGroup = data.pending && data.groups.find((g) => g.id === data.pending!.groupId);
  const wait = data.nextAt - Date.now();

  return (
    <View>
      <View style={st.row}>
        <TouchableOpacity style={[st.btn, { flex: 1, backgroundColor: running ? C.danger : C.fb }]} onPress={() => (running ? stop('⏸ أوقفته.') : start())}>
          <Text style={st.btnTxt}>{running ? '⏸ إيقاف' : '▶ تشغيل تلقائي'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[st.btn, st.outline]} onPress={() => { stop('سجّل دخولك في المتصفح بالأسفل، ثم اضغط «تشغيل تلقائي».'); setUrl('https://m.facebook.com/login'); }}>
          <Text style={[st.btnTxt, { color: C.fb }]}>🔑 تسجيل الدخول</Text>
        </TouchableOpacity>
      </View>

      <View style={st.statusBox}>
        <Text style={st.status}>{status}</Text>
        {running && wait > 0 && <Text style={st.muted}>القروب التالي بعد {Math.floor(wait / 60000)}:{String(Math.floor((wait % 60000) / 1000)).padStart(2, '0')}</Text>}
        <Text style={st.muted}>اليوم: {postedToday(data, Date.now())} من {DAILY_SOFT_LIMIT} · خلّ التطبيق مفتوح والشاشة شغّالة أثناء النشر.</Text>
      </View>

      {!running && pendingGroup && (
        <View style={st.row}>
          <TouchableOpacity style={[st.btn, { flex: 1, backgroundColor: C.brand }]} onPress={() => { commit((x) => applyPosted(x, pendingGroup.id, Date.now())); addLog('✓ «' + pendingGroup.name + '» (يدوي)'); }}>
            <Text style={[st.btnTxt, { color: '#04220f' }]}>✓ نشرت «{pendingGroup.name}»</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[st.btn, st.outline]} onPress={() => commit((x) => ({ ...x, pending: null }))}>
            <Text style={[st.btnTxt, { color: C.txt }]}>تخطَّ</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={st.webBox}>
        <WebView
          ref={web}
          source={{ uri: url }}
          userAgent={UA}
          onLoadEnd={onLoadEnd}
          onMessage={onMessage}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          setSupportMultipleWindows={false}
          nestedScrollEnabled
        />
      </View>

      {log.map((l, i) => <Text key={i + l} style={st.logLine}>{l}</Text>)}
    </View>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, marginTop: 10 },
  btn: { borderRadius: 10, minHeight: 48, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 14 },
  outline: { borderWidth: 1, borderColor: C.line, backgroundColor: C.card },
  btnTxt: { color: '#fff', fontWeight: '700', fontSize: 14 },
  statusBox: { borderWidth: 1, borderColor: C.fb, borderRadius: 12, padding: 12, marginTop: 12, backgroundColor: '#101a2b' },
  status: { color: C.txt, fontSize: 14, lineHeight: 21 },
  muted: { color: C.muted, fontSize: 12, marginTop: 6 },
  webBox: { height: 520, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: C.line, marginTop: 12, backgroundColor: '#fff' },
  logLine: { color: C.muted, fontSize: 12, marginTop: 6 },
});
