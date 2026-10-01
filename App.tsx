/**
 * App.tsx — واجهة «مُجدوِل واتساب» لأندرويد.
 * تبويبات: الاتصال (QR) · إنشاء · الطابور · الأشخاص · السجل.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  SafeAreaView, View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, I18nManager, StatusBar, Alert, Image,
} from 'react-native';
import DocumentPicker, { types } from 'react-native-document-picker';
import { startEngine, call, on } from './src/bridge';

I18nManager.allowRTL(true);
I18nManager.forceRTL(true);

type Tab = 'connect' | 'compose' | 'queue' | 'contacts' | 'logs';
// الفاصل العشوائي بين مستلم وآخر (بالثواني) — الأطول أأمن من الحظر
const GAPS = {
  fast: { label: 'سريع', hint: '8–20 ث', min: 8, max: 20 },
  medium: { label: 'متوسط', hint: '30–90 ث', min: 30, max: 90 },
  safe: { label: 'آمن', hint: '1–3 د', min: 60, max: 180 },
} as const;
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
  const [media, setMedia] = useState<any>(null); // {path, name, type}
  const [audience, setAudience] = useState<'contacts' | 'groups' | 'both'>('contacts');
  const [jitter, setJitter] = useState<0 | 15 | 30 | 60>(15);
  const [gap, setGap] = useState<keyof typeof GAPS>('medium');
  const [groups, setGroups] = useState<{ group_id: string; name: string }[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsError, setGroupsError] = useState('');
  const [groupQuery, setGroupQuery] = useState('');
  const [selGroups, setSelGroups] = useState<Set<string>>(new Set());

  const loadGroups = useCallback(async () => {
    setGroupsLoading(true); setGroupsError('');
    try {
      const list = await call('fetchGroups');
      list.sort((a: any, b: any) => (a.name || '').localeCompare(b.name || '', 'ar'));
      setGroups(list);
    } catch (e: any) { setGroupsError(e.message || 'تعذّر جلب القروبات.'); }
    finally { setGroupsLoading(false); }
  }, []);

  function toggleGroup(id: string) {
    setSelGroups((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function pickMedia() {
    try {
      const res = await DocumentPicker.pickSingle({
        type: [types.images, types.video],
        copyTo: 'cachesDirectory',
      });
      const uri = (res.fileCopyUri || res.uri || '').replace(/^file:\/\//, '');
      const mt = (res.type || '').startsWith('video') ? 'video' : 'image';
      setMedia({ path: decodeURIComponent(uri), name: res.name || 'ملف', type: mt });
    } catch (e: any) {
      if (!DocumentPicker.isCancel(e)) Alert.alert('خطأ', 'تعذّر اختيار الملف: ' + e.message);
    }
  }

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
    if (!body.trim() && !media) return Alert.alert('تنبيه', 'اكتب نصاً أو أرفق وسائط.');
    let targets: any[] = [];
    if (kind === 'message') {
      if (audience !== 'groups') {
        if (!contacts.length) return Alert.alert('تنبيه', 'أضف أشخاصاً في تبويب «الأشخاص» أولاً.');
        targets = contacts.map((c) => ({ name: c.name, number: c.number, isGroup: false }));
      }
      if (audience !== 'contacts') {
        const picked = groups.filter((g) => selGroups.has(g.group_id));
        if (!picked.length) return Alert.alert('تنبيه', 'اختر قروباً واحداً على الأقل.');
        targets = targets.concat(picked.map((g) => ({ name: g.name, id: g.group_id, isGroup: true })));
      }
    }
    try {
      await call('taskAdd', {
        title: kind === 'status' ? 'حالة' : 'رسالة', kind, targets,
        body: body.trim(), run_at, repeat_type: repeat,
        jitter_min: jitter, min_delay: GAPS[gap].min, max_delay: GAPS[gap].max,
        media_path: media ? media.path : null,
        media_type: media ? media.type : null,
      });
      setBody(''); setMedia(null);
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
                    {state.error ? <Text style={{ color: C.warn, fontSize: 13, marginBottom: 8 }}>{state.error}</Text> : null}
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
              <TouchableOpacity style={[s.seg, kind === 'message' && s.segOn]} onPress={() => setKind('message')}><Text style={s.segTxt}>رسالة</Text></TouchableOpacity>
              <TouchableOpacity style={[s.seg, kind === 'status' && s.segOn]} onPress={() => setKind('status')}><Text style={s.segTxt}>حالة (Status)</Text></TouchableOpacity>
            </View>

            {kind === 'message' && (
              <>
                <Text style={s.lbl}>إرسال إلى</Text>
                <View style={s.rowSeg}>
                  {(['contacts', 'groups', 'both'] as const).map((a) => (
                    <TouchableOpacity key={a} style={[s.seg, audience === a && s.segOn]} onPress={() => {
                      setAudience(a);
                      if (a !== 'contacts' && !groups.length && !groupsLoading && state.state === 'ready') loadGroups();
                    }}>
                      <Text style={s.segTxt}>{a === 'contacts' ? `الأشخاص (${contacts.length})` : a === 'groups' ? 'قروبات' : 'الاثنين'}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {audience !== 'contacts' && (
                  <View style={s.groupBox}>
                    <View style={s.row}>
                      <Text style={[s.itemTitle, { flex: 1 }]}>القروبات · مختار {selGroups.size}</Text>
                      <TouchableOpacity style={s.smallBtn} disabled={groupsLoading || state.state !== 'ready'} onPress={loadGroups}>
                        <Text style={[s.segTxt, { color: C.brand }]}>{groupsLoading ? 'جارٍ الجلب…' : '↻ تحديث'}</Text>
                      </TouchableOpacity>
                    </View>

                    {state.state !== 'ready' ? (
                      <Text style={s.muted}>اربط واتساب من تبويب «الاتصال» أولاً لجلب قروباتك.</Text>
                    ) : groupsError ? (
                      <Text style={[s.muted, { color: C.danger }]}>{groupsError} — اضغط «تحديث» للمحاولة مجدداً.</Text>
                    ) : !groups.length ? (
                      <Text style={s.muted}>{groupsLoading ? 'جارٍ جلب قروباتك من واتساب…' : 'لا توجد قروبات. اضغط «تحديث».'}</Text>
                    ) : (
                      <>
                        <TextInput style={[s.input, { marginTop: 8 }]} value={groupQuery} onChangeText={setGroupQuery} placeholder={`ابحث في ${groups.length} قروب…`} placeholderTextColor={C.muted} />
                        {(() => {
                          const q = groupQuery.trim();
                          const shown = q ? groups.filter((g) => (g.name || '').includes(q)) : groups;
                          const allOn = shown.length > 0 && shown.every((g) => selGroups.has(g.group_id));
                          return (
                            <>
                              <TouchableOpacity style={s.smallBtn} onPress={() => setSelGroups((prev) => {
                                const n = new Set(prev); shown.forEach((g) => (allOn ? n.delete(g.group_id) : n.add(g.group_id))); return n;
                              })}>
                                <Text style={[s.segTxt, { color: C.brand }]}>{allOn ? 'إلغاء تحديد الظاهر' : `تحديد الظاهر (${shown.length})`}</Text>
                              </TouchableOpacity>
                              {shown.slice(0, 60).map((g) => {
                                const on = selGroups.has(g.group_id);
                                return (
                                  <TouchableOpacity key={g.group_id} style={s.checkRow} onPress={() => toggleGroup(g.group_id)}
                                    accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
                                    <View style={[s.check, on && s.checkOn]}>{on && <Text style={{ color: '#04220f', fontWeight: '700' }}>✓</Text>}</View>
                                    <Text style={[s.itemTitle, { flex: 1 }]} numberOfLines={1}>{g.name || 'قروب بلا اسم'}</Text>
                                  </TouchableOpacity>
                                );
                              })}
                              {shown.length > 60 && <Text style={s.muted}>يظهر أول 60 — استخدم البحث للوصول للبقية.</Text>}
                            </>
                          );
                        })()}
                      </>
                    )}
                  </View>
                )}
              </>
            )}
            <Text style={s.lbl}>النص (يدعم {'{الاسم}'})</Text>
            <TextInput style={[s.input, { height: 100 }]} multiline value={body} onChangeText={setBody} placeholder="اكتب الرسالة أو الحالة…" placeholderTextColor={C.muted} />

            <Text style={s.lbl}>الوسائط (صورة/فيديو — اختياري)</Text>
            <View style={s.row}>
              <TouchableOpacity style={[s.seg, { flex: 1 }]} onPress={pickMedia}>
                <Text style={s.segTxt}>📎 {media ? 'تغيير الوسائط' : 'إرفاق صورة/فيديو'}</Text>
              </TouchableOpacity>
              {media && (
                <TouchableOpacity style={[s.seg, { width: 70 }]} onPress={() => setMedia(null)}>
                  <Text style={[s.segTxt, { color: C.danger }]}>إزالة</Text>
                </TouchableOpacity>
              )}
            </View>
            {media && <Text style={s.muted}>✓ {media.name} ({media.type === 'video' ? 'فيديو' : 'صورة'})</Text>}

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

            <Text style={s.lbl}>🛡️ توقيت عشوائي للبدء (للحماية)</Text>
            <View style={s.rowSeg}>
              {([0, 15, 30, 60] as const).map((j) => (
                <TouchableOpacity key={j} style={[s.seg, jitter === j && s.segOn]} onPress={() => setJitter(j)}>
                  <Text style={s.segTxt}>{j === 0 ? 'بدون' : `حتى ${j} د`}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={s.muted}>{jitter ? `يبدأ في لحظة عشوائية خلال ${jitter} دقيقة بعد الوقت المحدد، وتتغيّر في كل تكرار.` : 'يبدأ في الوقت المحدد بالضبط.'}</Text>

            {kind === 'message' && (
              <>
                <Text style={s.lbl}>🛡️ الفاصل بين كل مستلم والذي يليه</Text>
                <View style={s.rowSeg}>
                  {(Object.keys(GAPS) as (keyof typeof GAPS)[]).map((g) => (
                    <TouchableOpacity key={g} style={[s.seg, gap === g && s.segOn]} onPress={() => setGap(g)}>
                      <Text style={s.segTxt}>{GAPS[g].label}</Text>
                      <Text style={[s.muted, { marginTop: 2 }]}>{GAPS[g].hint}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={s.muted}>ترتيب المستلمين عشوائي في كل مرة، ويظهر «يكتب…» قبل كل رسالة.</Text>
              </>
            )}

            <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={addTask}><Text style={[s.btnTxt, { color: '#04220f' }]}>➕ إضافة إلى الطابور</Text></TouchableOpacity>
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  groupBox: { borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 12, marginTop: 8 },
  smallBtn: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 8 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, borderBottomWidth: 1, borderColor: C.line },
  check: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: C.muted, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: C.brand, borderColor: C.brand },
  itemTitle: { color: C.txt, fontSize: 14 },
});
