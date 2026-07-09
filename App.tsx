/**
 * App.tsx — واجهة «مُجدوِل واتساب» لأندرويد.
 * تبويبات: الاتصال (QR) · إنشاء · الطابور · الأشخاص · السجل.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  SafeAreaView, View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, I18nManager, StatusBar, Alert, Image,
} from 'react-native';
import { startEngine, call, on } from './src/bridge';

I18nManager.allowRTL(true);
I18nManager.forceRTL(true);

type Tab = 'connect' | 'compose' | 'queue' | 'contacts' | 'logs';
const C = { bg: '#0e1a12', card: '#16241b', line: '#26382c', txt: '#e8f4ec', muted: '#8fb3a0', brand: '#25d366', danger: '#ef4444', warn: '#f3d27a' };

export default function App() {
  const [tab, setTab] = useState<Tab>('connect');
  const [state, setState] = useState<any>({ state: 'disconnected', qr: null });
  const [tasks, setTasks] = useState<any[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [stats, setStats] = useState<any>({ sent: 0, failed: 0, total: 0 });

  const [kind, setKind] = useState<'message' | 'status'>('message');
  const [body, setBody] = useState('');
  const [minsFromNow, setMinsFromNow] = useState('5');
  const [repeat, setRepeat] = useState<'none' | 'daily' | 'weekly'>('none');
  const [cName, setCName] = useState('');
  const [cNum, setCNum] = useState('');
  const [pairNum, setPairNum] = useState('');

  const refreshTasks = useCallback(() => call('tasksList').then(setTasks).catch(() => {}), []);
  const refreshContacts = useCallback(() => call('contactsList').then(setContacts).catch(() => {}), []);
  const refreshLogs = useCallback(() => {
    call('logsList').then(setLogs).catch(() => {});
    call('logsStats').then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    startEngine();
    const offReady = on('ready', () => { call('getState').then(setState).catch(() => {}); refreshTasks(); refreshContacts(); refreshLogs(); });
    const offState = on('state', (st) => setState(st));
    const offTasks = on('tasks:changed', refreshTasks);
    const offLogs = on('logs:changed', refreshLogs);
    call('getState').then(setState).catch(() => {});
    return () => { offReady(); offState(); offTasks(); offLogs(); };
  }, [refreshTasks, refreshContacts, refreshLogs]);

  const connLabel = state.state === 'ready' ? 'متصل ✓' : state.state === 'pairing' ? 'أدخل الرمز' : state.state === 'qr' ? 'امسح الرمز' : state.state === 'connecting' ? 'جارٍ الاتصال…' : 'غير متصل';

  async function addTask() {
    const mins = parseInt(minsFromNow) || 5;
    const run_at = Date.now() + mins * 60000;
    if (!body.trim()) return Alert.alert('تنبيه', 'اكتب نص الرسالة/الحالة.');
    let targets: any[] = [];
    if (kind === 'message') {
      if (!contacts.length) return Alert.alert('تنبيه', 'أضف أشخاصاً في تبويب «الأشخاص» أولاً.');
      targets = contacts.map((c) => ({ name: c.name, number: c.number, isGroup: false }));
    }
    try {
      await call('taskAdd', { title: kind === 'status' ? 'حالة' : 'رسالة', kind, targets, body: body.trim(), run_at, repeat_type: repeat });
      setBody('');
      refreshTasks();
      Alert.alert('تم', 'أُضيفت المهمة إلى الطابور.');
      setTab('queue');
    } catch (e: any) { Alert.alert('خطأ', e.message); }
  }

  async function addContact() {
    if (!cNum.trim()) return Alert.alert('تنبيه', 'أدخل الرقم بصيغة دولية.');
    try { await call('contactAdd', { name: cName.trim(), number: cNum.trim(), list: 'عام' }); setCName(''); setCNum(''); refreshContacts(); }
    catch (e: any) { Alert.alert('خطأ', e.message); }
  }

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.card} />
      <View style={s.topbar}>
        <Text style={s.brand}>🟢 مُجدوِل واتساب</Text>
        <View style={[s.badge, { backgroundColor: state.state === 'ready' ? '#12301f' : '#3a2020' }]}>
          <Text style={{ color: state.state === 'ready' ? '#6ff0a5' : '#ff9a9a', fontSize: 12 }}>{connLabel}</Text>
        </View>
      </View>

      <View style={s.tabs}>
        {(['connect', 'compose', 'queue', 'contacts', 'logs'] as Tab[]).map((t) => (
          <TouchableOpacity key={t} onPress={() => { setTab(t); if (t === 'queue') refreshTasks(); if (t === 'contacts') refreshContacts(); if (t === 'logs') refreshLogs(); }} style={[s.tab, tab === t && s.tabActive]}>
            <Text style={[s.tabTxt, tab === t && { color: C.brand }]}>
              {t === 'connect' ? 'الاتصال' : t === 'compose' ? 'إنشاء' : t === 'queue' ? 'الطابور' : t === 'contacts' ? 'الأشخاص' : 'السجل'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14 }}>
        <View style={s.warn}><Text style={{ color: C.warn, fontSize: 12 }}>⚠️ الاستخدام المكثف قد يعرّض رقمك للحظر. استخدمه باعتدال.</Text></View>

        {tab === 'connect' && (
          <View style={s.card}>
            <Text style={s.h2}>ربط حساب واتساب</Text>
            {state.state === 'ready' ? (
              <Text style={{ color: C.brand, textAlign: 'center', marginVertical: 30 }}>✅ الحساب متصل وجاهز</Text>
            ) : state.qr ? (
              <View style={{ alignItems: 'center', marginVertical: 16 }}>
                <View style={{ backgroundColor: '#fff', padding: 12, borderRadius: 12 }}>
                  <Image source={{ uri: state.qr }} style={{ width: 240, height: 240 }} resizeMode="contain" />
                </View>
                <Text style={[s.muted, { marginTop: 12 }]}>واتساب ← الأجهزة المرتبطة ← ربط جهاز</Text>
              </View>
            ) : (
              <Text style={[s.muted, { textAlign: 'center', marginVertical: 30 }]}>⏳ جارٍ تحضير رمز QR…</Text>
            )}

            {/* الربط برمز — للربط على نفس الجوال بلا كاميرا */}
            {state.state !== 'ready' && (
              <View style={{ borderTopWidth: 1, borderColor: C.line, marginTop: 16, paddingTop: 16 }}>
                <Text style={[s.h2, { fontSize: 15 }]}>أو الربط برمز (نفس الجوال)</Text>
                {state.pairingCode ? (
                  <View style={{ alignItems: 'center', marginVertical: 12 }}>
                    <Text style={s.muted}>اكتب هذا الرمز في واتساب:</Text>
                    <Text style={{ color: C.brand, fontSize: 32, fontWeight: '700', letterSpacing: 4, marginVertical: 8 }}>{state.pairingCode}</Text>
                    <Text style={[s.muted, { textAlign: 'center' }]}>واتساب ← الأجهزة المرتبطة ← ربط جهاز ← «الربط برقم الهاتف بدلاً من ذلك» ← أدخل الرمز</Text>
                  </View>
                ) : (
                  <>
                    <TextInput style={s.input} value={pairNum} onChangeText={setPairNum} keyboardType="phone-pad" placeholder="رقمك الدولي بلا + مثل 9677xxxxxxxx" placeholderTextColor={C.muted} />
                    <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={() => {
                      const n = pairNum.replace(/[^\d]/g, '');
                      if (n.length < 8) return Alert.alert('تنبيه', 'أدخل رقمك بصيغة دولية (رمز الدولة + الرقم).');
                      call('requestPairing', n).catch((e: any) => Alert.alert('خطأ', e.message));
                    }}>
                      <Text style={[s.btnTxt, { color: '#04220f' }]}>🔑 إنشاء رمز ربط</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            )}

            {state.state === 'ready' && (
              <TouchableOpacity style={[s.btn, s.btnDanger]} onPress={() => call('logout').then(() => call('getState').then(setState))}>
                <Text style={s.btnTxt}>تسجيل الخروج / فصل الجلسة</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {tab === 'compose' && (
          <View style={s.card}>
            <Text style={s.h2}>إنشاء مهمة</Text>
            <View style={s.rowSeg}>
              <TouchableOpacity style={[s.seg, kind === 'message' && s.segOn]} onPress={() => setKind('message')}><Text style={s.segTxt}>رسالة لأشخاص</Text></TouchableOpacity>
              <TouchableOpacity style={[s.seg, kind === 'status' && s.segOn]} onPress={() => setKind('status')}><Text style={s.segTxt}>حالة (Status)</Text></TouchableOpacity>
            </View>
            <Text style={s.lbl}>النص (يدعم {'{الاسم}'})</Text>
            <TextInput style={[s.input, { height: 100 }]} multiline value={body} onChangeText={setBody} placeholder="اكتب الرسالة أو الحالة…" placeholderTextColor={C.muted} />
            <Text style={s.lbl}>بعد كم دقيقة من الآن؟</Text>
            <TextInput style={s.input} keyboardType="numeric" value={minsFromNow} onChangeText={setMinsFromNow} placeholderTextColor={C.muted} />
            <Text style={s.lbl}>التكرار</Text>
            <View style={s.rowSeg}>
              {(['none', 'daily', 'weekly'] as const).map((r) => (
                <TouchableOpacity key={r} style={[s.seg, repeat === r && s.segOn]} onPress={() => setRepeat(r)}>
                  <Text style={s.segTxt}>{r === 'none' ? 'مرة' : r === 'daily' ? 'يومي' : 'أسبوعي'}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={addTask}><Text style={[s.btnTxt, { color: '#04220f' }]}>➕ إضافة إلى الطابور</Text></TouchableOpacity>
            <Text style={s.muted}>ملاحظة: إرفاق الوسائط يُضاف في تحديث قادم — حالياً نص فقط.</Text>
          </View>
        )}

        {tab === 'queue' && (
          <View style={s.card}>
            <Text style={s.h2}>الطابور</Text>
            {tasks.length === 0 && <Text style={s.muted}>لا توجد مهام بعد.</Text>}
            {tasks.map((t) => (
              <View key={t.id} style={s.item}>
                <View style={{ flex: 1 }}>
                  <Text style={s.itemTitle}>{t.title} · {t.kind === 'status' ? 'حالة' : 'رسالة'}</Text>
                  <Text style={s.muted}>{new Date(t.run_at).toLocaleString('ar')} · {t.status}{t.last_error ? ' · ' + t.last_error.slice(0, 30) : ''}</Text>
                </View>
                <TouchableOpacity onPress={() => call('taskRemove', t.id).then(setTasks)}><Text style={{ color: C.danger }}>حذف</Text></TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {tab === 'contacts' && (
          <View style={s.card}>
            <Text style={s.h2}>الأشخاص</Text>
            <TextInput style={s.input} value={cName} onChangeText={setCName} placeholder="الاسم" placeholderTextColor={C.muted} />
            <TextInput style={s.input} value={cNum} onChangeText={setCNum} keyboardType="phone-pad" placeholder="الرقم الدولي 9677xxxxxxxx" placeholderTextColor={C.muted} />
            <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={addContact}><Text style={[s.btnTxt, { color: '#04220f' }]}>إضافة</Text></TouchableOpacity>
            {contacts.map((c) => (
              <View key={c.id} style={s.item}>
                <Text style={{ color: C.txt, flex: 1 }}>{c.name || '—'} · {c.number}</Text>
                <TouchableOpacity onPress={() => call('contactRemove', c.id).then(setContacts)}><Text style={{ color: C.danger }}>حذف</Text></TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {tab === 'logs' && (
          <View style={s.card}>
            <Text style={s.h2}>السجل</Text>
            <Text style={s.muted}>ناجحة {stats.sent} · فاشلة {stats.failed} · الإجمالي {stats.total}</Text>
            {logs.map((l, i) => (
              <View key={i} style={s.item}>
                <Text style={{ color: l.ok ? C.brand : C.danger, flex: 1 }}>{l.ok ? '✓' : '✗'} {l.title} · {l.target}</Text>
                <Text style={s.muted}>{new Date(l.at).toLocaleTimeString('ar')}</Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  topbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, backgroundColor: C.card, borderBottomWidth: 1, borderColor: C.line },
  brand: { color: C.brand, fontSize: 17, fontWeight: '700' },
  badge: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999 },
  tabs: { flexDirection: 'row', backgroundColor: C.card, borderBottomWidth: 1, borderColor: C.line },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderColor: C.brand },
  tabTxt: { color: C.muted, fontSize: 13, fontWeight: '600' },
  warn: { backgroundColor: '#2a2110', borderColor: '#5a441a', borderWidth: 1, padding: 10, borderRadius: 10, marginBottom: 14 },
  card: { backgroundColor: C.card, borderColor: C.line, borderWidth: 1, borderRadius: 14, padding: 16, marginBottom: 14 },
  h2: { color: C.txt, fontSize: 16, fontWeight: '700', marginBottom: 10 },
  lbl: { color: C.muted, fontSize: 13, marginTop: 10, marginBottom: 4 },
  muted: { color: C.muted, fontSize: 12, marginTop: 6 },
  input: { backgroundColor: C.bg, borderColor: C.line, borderWidth: 1, borderRadius: 10, color: C.txt, paddingHorizontal: 12, paddingVertical: 10, textAlign: 'right' },
  btn: { borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginTop: 14 },
  btnPrimary: { backgroundColor: C.brand },
  btnDanger: { backgroundColor: C.danger },
  btnTxt: { color: '#fff', fontWeight: '700', fontSize: 14 },
  rowSeg: { flexDirection: 'row', gap: 8, marginVertical: 6 },
  seg: { flex: 1, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: C.line, alignItems: 'center' },
  segOn: { backgroundColor: '#12301f', borderColor: C.brand },
  segTxt: { color: C.txt, fontSize: 13 },
  item: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderColor: C.line },
  itemTitle: { color: C.txt, fontSize: 14 },
});
