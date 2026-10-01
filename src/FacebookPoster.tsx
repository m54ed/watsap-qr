/**
 * FacebookPoster.tsx — مساعد نشر نصف آلي في قروبات فيسبوك.
 * لا يتحكم بفيسبوك ولا ينشر بنفسه: يجهّز صياغة مختلفة لكل قروب، ينسخها للحافظة، يفتح القروب،
 * والمستخدم يلصق وينشر بيده — ثم يفرض فاصلاً عشوائياً قبل القروب التالي (حماية الحساب).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, Linking, Clipboard, AppState, Image } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DocumentPicker, { types } from 'react-native-document-picker';
import { C } from './theme';
import { call } from './bridge';
import {
  Data, Group, Pending, DAY, DAILY_SOFT_LIMIT, GAPS, EMPTY, rand, groupKey,
  dueGroups, postedToday as countToday, pickJob, applyPosted,
} from './fbShared';
import FbAutoPanel from './FbAutoPanel';

const KEY = 'fbPoster.v1';

// يقبل رابط القروب أو رقمه (ID) وحده — الرقم أثبت لأن الاسم المخصص في الرابط قد يغيّره المشرف
const isGroupId = (u: string) => /^\d{5,20}$/.test(u.trim());
const isGroupUrl = (u: string) => isGroupId(u) || /^(https?:\/\/)?(www\.|m\.|web\.)?(facebook|fb)\.com\/groups\/[^/?#\s]+/i.test(u.trim());
const normUrl = (u: string) => (isGroupId(u) ? 'https://www.facebook.com/groups/' + u.trim()
  : /^https?:\/\//i.test(u.trim()) ? u.trim() : 'https://' + u.trim());

/**
 * يستخرج القروبات من نص حر (ملف أو لصق): سطر لكل قروب = رابط أو رقم، ويُقبل اسم بعده
 * (مفصولاً بمسافة/Tab/|/,). السطر الذي فيه عدة روابط يُضاف كله بلا أسماء.
 */
export function parseGroupList(text: string) {
  const found: { token: string; name: string }[] = [];
  let bad = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const links = [...line.matchAll(/(?:https?:\/\/)?(?:www\.|m\.|web\.)?(?:facebook|fb)\.com\/groups\/([^/?#\s|,;]+)[^\s|,;]*/gi)];
    if (links.length > 1) { links.forEach((m) => found.push({ token: m[1], name: '' })); continue; }
    let token = '', rest = line;
    if (links.length === 1) { token = links[0][1]; rest = line.replace(links[0][0], ' '); }
    else {
      // آيدي القروب = أطول سلسلة أرقام لا تبدأ بصفر (الآيديات 15–16 رقماً) — لا تُؤخذ أسعار أو جوالات في الاسم
      const runs = (line.match(/\d{5,20}/g) || []).filter((r) => r[0] !== '0');
      const id = runs.reduce((best, r) => (r.length > best.length ? r : best), '');
      if (id) { token = id; rest = line.replace(id, ' '); }
    }
    if (!token) { bad++; continue; }
    found.push({ token, name: rest.replace(/[\t|,;]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s:\-–]+|[\s:\-–]+$/g, '').trim() });
  }
  return { found, bad };
}

const ago = (t?: number) => {
  if (!t) return 'لم يُنشر بعد';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'الآن' : m < 60 ? `منذ ${m} د` : m < 1440 ? `منذ ${Math.round(m / 60)} س` : `منذ ${Math.round(m / 1440)} يوم`;
};
const mmss = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export default function FacebookPoster() {
  const [data, setData] = useState<Data>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<'post' | 'groups' | 'run'>('post');
  const [gName, setGName] = useState('');
  const [gUrl, setGUrl] = useState('');
  const [bulk, setBulk] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const lastVariant = useRef(-1);

  useEffect(() => {
    AsyncStorage.getItem(KEY).then((raw) => { if (raw) setData({ ...EMPTY, ...JSON.parse(raw) }); }).catch(() => {}).finally(() => setLoaded(true));
  }, []);
  const save = useCallback((patch: Partial<Data>) => setData((d) => ({ ...d, ...patch })), []);
  // حفظ مؤجَّل 400ms — لا كتابة كاملة للتخزين مع كل حرف
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => { AsyncStorage.setItem(KEY, JSON.stringify(data)).catch(() => {}); }, 400);
    return () => clearTimeout(t);
  }, [data, loaded]);

  // عدّاد الفاصل + إعادة الرسم عند الرجوع من فيسبوك
  useEffect(() => {
    if ((data.nextAt || 0) <= now) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [data.nextAt, now]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') setNow(Date.now()); });
    const t = setInterval(() => setNow(Date.now()), 30000); // كي لا تتجمّد «المتبقي اليوم» والتحذير
    return () => { sub.remove(); clearInterval(t); };
  }, []);

  const variants = data.variants.map((v) => v.trim()).filter(Boolean);
  const postedToday = countToday(data, now);
  const due = dueGroups(data, now);
  const pending = data.pending;
  const setPending = (p: Pending | null) => save({ pending: p });
  const nextAt = data.nextAt || 0; // محفوظ: لا يُتجاوز الفاصل بإغلاق التطبيق
  const waiting = nextAt > now;

  async function pickImages() {
    try {
      const res = await DocumentPicker.pick({ type: [types.images], allowMultiSelection: true, copyTo: 'documentDirectory' });
      const imgs = res.map((r) => ({ uri: r.fileCopyUri || r.uri, name: r.name || 'صورة' }));
      save({ images: data.images.concat(imgs).slice(0, 10) });
    } catch (e: any) { if (!DocumentPicker.isCancel(e)) Alert.alert('خطأ', 'تعذّر اختيار الصور: ' + e.message); }
  }

  function addGroup() {
    if (!isGroupUrl(gUrl)) return Alert.alert('تنبيه', 'الصق رابط القروب أو رقمه، مثل:\nfacebook.com/groups/اسم-القروب\nأو 123456789012345');
    const url = normUrl(gUrl);
    if (data.groups.some((g) => groupKey(g.url) === groupKey(url))) return Alert.alert('تنبيه', 'هذا القروب مضاف من قبل.');
    const slug = url.split('/groups/')[1].split(/[/?#]/)[0];
    save({ groups: data.groups.concat({ id: String(Date.now()), name: gName.trim() || slug, url }) });
    setGName(''); setGUrl('');
  }

  /** إضافة جماعية من نص (لصق أو ملف): يتخطى المكرر ويعرض ملخصاً. */
  function importText(text: string) {
    const { found, bad } = parseGroupList(text);
    const seen = new Set(data.groups.map((g) => groupKey(g.url)));
    const added: Group[] = [];
    let dup = 0;
    found.forEach((f, i) => {
      const key = f.token.toLowerCase();
      if (seen.has(key)) { dup++; return; }
      seen.add(key);
      added.push({ id: `${Date.now()}-${i}`, name: f.name || f.token, url: 'https://www.facebook.com/groups/' + f.token });
    });
    if (added.length) save({ groups: data.groups.concat(added) });
    if (added.length) setBulk('');
    Alert.alert('الإضافة الجماعية', `أُضيف ${added.length} قروب` + (dup ? `\nمكرر (تُخطّي): ${dup}` : '') + (bad ? `\nأسطر بلا رابط أو رقم: ${bad}` : ''));
  }

  async function importFile() {
    try {
      const f = await DocumentPicker.pickSingle({ type: [types.plainText, types.csv, 'text/*'], copyTo: 'cachesDirectory' });
      const path = decodeURIComponent((f.fileCopyUri || f.uri || '').replace(/^file:\/\//, ''));
      importText(await call('readTextFile', path));
    } catch (e: any) { if (!DocumentPicker.isCancel(e)) Alert.alert('خطأ', 'تعذّر قراءة الملف: ' + e.message); }
  }

  function openNext() {
    if (!variants.length) { setView('post'); return Alert.alert('تنبيه', 'اكتب صياغة واحدة على الأقل للمنشور.'); }
    const job = pickJob(data, Date.now(), lastVariant);
    if (!job) return Alert.alert('خلصت', 'نشرت في كل قروباتك خلال آخر 24 ساعة.');
    Clipboard.setString(job.text);
    setPending({ groupId: job.groupId, text: job.text });
    Linking.openURL(job.group.url).catch(() => Alert.alert('خطأ', 'تعذّر فتح الرابط.'));
  }

  function markPosted() {
    if (!pending) return;
    const at = Date.now();
    setData((d) => applyPosted(d, pending.groupId, at));
    setNow(at);
  }


  if (!loaded) return <Text style={st.muted}>جارٍ التحميل…</Text>;
  const pendingGroup = pending && data.groups.find((g) => g.id === pending.groupId);

  return (
    <View>
      <View style={st.segRow}>
        {([['post', 'المنشور'], ['groups', `القروبات (${data.groups.length})`], ['run', 'النشر']] as const).map(([k, l]) => (
          <TouchableOpacity key={k} style={[st.seg, view === k && st.segOn]} onPress={() => setView(k)}>
            <Text style={[st.segTxt, view === k && { color: C.fb }]}>{l}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {view === 'post' && (
        <View style={st.card}>
          <Text style={st.h2}>صياغات المنشور</Text>
          <Text style={st.muted}>اكتب أكثر من صياغة لنفس الفكرة — تُختار واحدة مختلفة لكل قروب حتى لا يتكرر النص بالحرف.</Text>
          {data.variants.map((v, i) => (
            <View key={i} style={{ marginTop: 10 }}>
              <View style={st.rowBetween}>
                <Text style={st.lbl}>الصياغة {i + 1}</Text>
                {data.variants.length > 1 && (
                  <TouchableOpacity style={st.small} onPress={() => save({ variants: data.variants.filter((_, j) => j !== i) })}>
                    <Text style={{ color: C.danger }}>حذف</Text>
                  </TouchableOpacity>
                )}
              </View>
              <TextInput style={[st.input, { height: 96 }]} multiline value={v} placeholder="نص المنشور…" placeholderTextColor={C.muted}
                onChangeText={(t) => save({ variants: data.variants.map((x, j) => (j === i ? t : x)) })} />
            </View>
          ))}
          {data.variants.length < 6 && (
            <TouchableOpacity style={st.outlineBtn} onPress={() => save({ variants: data.variants.concat('') })}>
              <Text style={[st.segTxt, { color: C.fb }]}>➕ صياغة أخرى</Text>
            </TouchableOpacity>
          )}

          <Text style={st.lbl}>الرابط (يُضاف أسفل النص)</Text>
          <TextInput style={st.input} value={data.link} onChangeText={(t) => save({ link: t })} placeholder="https://…" placeholderTextColor={C.muted} autoCapitalize="none" keyboardType="url" />

          <Text style={st.lbl}>الصور</Text>
          <Text style={st.muted}>فيسبوك لا يسمح بإرفاق الصور تلقائياً — تظهر هنا كتذكير، وتضيفها من المعرض داخل المنشور.</Text>
          <View style={st.thumbs}>
            {data.images.map((im, i) => (
              <TouchableOpacity key={im.uri + i} onLongPress={() => save({ images: data.images.filter((_, j) => j !== i) })}>
                <Image source={{ uri: im.uri }} style={st.thumb} />
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity style={st.outlineBtn} onPress={pickImages}><Text style={[st.segTxt, { color: C.fb }]}>🖼️ اختيار صور</Text></TouchableOpacity>
          {data.images.length > 0 && <Text style={st.muted}>اضغط مطوّلاً على صورة لإزالتها.</Text>}
        </View>
      )}

      {view === 'groups' && (
        <View style={st.card}>
          <Text style={st.h2}>القروبات</Text>
          <TextInput style={st.input} value={gUrl} onChangeText={setGUrl} placeholder="رابط القروب أو رقمه (ID)" placeholderTextColor={C.muted} autoCapitalize="none" keyboardType="url" />
          <TextInput style={[st.input, { marginTop: 8 }]} value={gName} onChangeText={setGName} placeholder="اسم مختصر (اختياري)" placeholderTextColor={C.muted} />
          <TouchableOpacity style={[st.btn, { backgroundColor: C.fb }]} onPress={addGroup}><Text style={st.btnTxt}>إضافة القروب</Text></TouchableOpacity>

          <View style={st.bulkBox}>
            <TouchableOpacity style={st.rowBetween} onPress={() => setBulkOpen(!bulkOpen)}>
              <Text style={st.itemTitle}>📥 إضافة جماعية (لصق أو ملف)</Text>
              <Text style={[st.segTxt, { color: C.fb }]}>{bulkOpen ? 'إخفاء' : 'فتح'}</Text>
            </TouchableOpacity>
            {bulkOpen && (
              <>
                <Text style={st.muted}>قروب في كل سطر: رابط أو رقم، ويمكن كتابة الاسم بعده. المكرر يُتخطّى تلقائياً.</Text>
                <TextInput style={[st.input, { height: 120, marginTop: 8 }]} multiline value={bulk} onChangeText={setBulk}
                  placeholder={'123456789012345 قروب السيارات\nfacebook.com/groups/riyadh-market'} placeholderTextColor={C.muted} autoCapitalize="none" />
                <View style={st.segRow}>
                  <TouchableOpacity style={[st.seg, { backgroundColor: C.fb, borderColor: C.fb }]} onPress={() => (bulk.trim() ? importText(bulk) : Alert.alert('تنبيه', 'الصق القائمة أولاً.'))}>
                    <Text style={st.btnTxt}>إضافة الكل</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={st.seg} onPress={importFile}>
                    <Text style={[st.segTxt, { color: C.fb }]}>📄 استيراد ملف txt</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
          {data.groups.length === 0 && <Text style={st.muted}>انسخ رابط القروب من فيسبوك (مشاركة ← نسخ الرابط) أو اكتب رقمه. الرقم أثبت: ما يتغيّر لو غيّر المشرف اسم الرابط.</Text>}
          {data.groups.map((g) => (
            <View key={g.id} style={st.item}>
              <View style={{ flex: 1 }}>
                <Text style={st.itemTitle} numberOfLines={1}>{g.name}</Text>
                <Text style={st.muted}>{ago(g.lastAt)}</Text>
              </View>
              <TouchableOpacity style={st.small} onPress={() => Alert.alert('حذف القروب', g.name, [
                { text: 'إلغاء', style: 'cancel' },
                { text: 'حذف', style: 'destructive', onPress: () => save({ groups: data.groups.filter((x) => x.id !== g.id) }) },
              ])}><Text style={{ color: C.danger }}>حذف</Text></TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {view === 'run' && (
        <View style={st.card}>
          <Text style={st.h2}>جلسة النشر</Text>
          <Text style={st.muted}>اليوم: {postedToday} منشور · متبقٍّ {due.length} من {data.groups.length} قروب</Text>
          {postedToday >= DAILY_SOFT_LIMIT && (
            <View style={st.warn}><Text style={{ color: C.warn, fontSize: 13 }}>⚠️ نشرت في {postedToday} قروب خلال 24 ساعة. الأفضل تتوقف لليوم — النشر الكثير يعرّض الحساب للتقييد.</Text></View>
          )}

          <Text style={st.lbl}>🛡️ الفاصل بين قروب والذي يليه</Text>
          <View style={st.segRow}>
            {(Object.keys(GAPS) as (keyof typeof GAPS)[]).map((k) => (
              <TouchableOpacity key={k} style={[st.seg, data.gap === k && st.segOn]} onPress={() => save({ gap: k })}>
                <Text style={st.segTxt}>{GAPS[k].label}</Text>
                <Text style={[st.muted, { marginTop: 2 }]}>{GAPS[k].hint}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={st.lbl}>طريقة النشر</Text>
          <View style={st.segRow}>
            {([['manual', 'يدوي (تنشر بيدك)'], ['auto', 'تلقائي (متصفح داخلي)']] as const).map(([k, l]) => (
              <TouchableOpacity key={k} style={[st.seg, data.postMode === k && st.segOn]} onPress={() => save({ postMode: k })}>
                <Text style={st.segTxt}>{l}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {data.postMode === 'auto' ? (
            <>
              <Text style={st.muted}>ينشر النص والرابط تلقائياً. الصور ما تُرفع تلقائياً (المتصفح لا يسمح باختيار ملفات بدونك).</Text>
              <FbAutoPanel data={data} setData={setData} lastVariant={lastVariant} />
            </>
          ) : pending && pendingGroup ? (
            <View style={st.pending}>
              <Text style={st.itemTitle}>📋 النص منسوخ — الصقه في «{pendingGroup.name}»</Text>
              <Text style={st.muted}>في فيسبوك: اضغط «اكتب شيئاً…» ← ضغطة مطوّلة ← لصق{data.images.length ? ` ← أضف ${data.images.length} صورة من المعرض` : ''} ← نشر.</Text>
              <Text style={st.preview} numberOfLines={4}>{pending.text}</Text>
              <TouchableOpacity style={[st.btn, { backgroundColor: C.brand }]} onPress={markPosted}><Text style={[st.btnTxt, { color: '#04220f' }]}>✓ نشرت</Text></TouchableOpacity>
              <View style={st.segRow}>
                <TouchableOpacity style={st.seg} onPress={() => { Clipboard.setString(pending.text); Linking.openURL(pendingGroup.url).catch(() => {}); }}>
                  <Text style={st.segTxt}>افتح القروب مجدداً</Text>
                </TouchableOpacity>
                <TouchableOpacity style={st.seg} onPress={() => setPending(null)}><Text style={st.segTxt}>تخطَّ</Text></TouchableOpacity>
              </View>
            </View>
          ) : waiting ? (
            <View style={st.pending}>
              <Text style={[st.itemTitle, { textAlign: 'center' }]}>⏳ القروب التالي بعد</Text>
              <Text style={st.countdown}>{mmss(nextAt - now)}</Text>
              <Text style={[st.muted, { textAlign: 'center' }]}>فاصل عشوائي لحماية حسابك. تقدر تطلع من التطبيق وترجع.</Text>
            </View>
          ) : (
            <TouchableOpacity style={[st.btn, { backgroundColor: C.fb, opacity: due.length ? 1 : 0.5 }]} onPress={openNext}>
              <Text style={st.btnTxt}>{due.length ? '▶ انسخ وافتح القروب التالي' : 'لا قروبات متبقية اليوم'}</Text>
            </TouchableOpacity>
          )}

          {data.log.length > 0 && <Text style={[st.lbl, { marginTop: 16 }]}>آخر المنشورات</Text>}
          {data.log.slice(0, 8).map((l, i) => (
            <View key={l.at + '-' + i} style={st.item}>
              <Text style={[st.itemTitle, { flex: 1 }]} numberOfLines={1}>✓ {l.group}</Text>
              <Text style={st.muted}>{ago(l.at)}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  card: { backgroundColor: C.card, borderColor: C.line, borderWidth: 1, borderRadius: 14, padding: 16, marginBottom: 14 },
  h2: { color: C.txt, fontSize: 16, fontWeight: '700', marginBottom: 6 },
  lbl: { color: C.muted, fontSize: 13, marginTop: 12, marginBottom: 4 },
  muted: { color: C.muted, fontSize: 12, marginTop: 4 },
  input: { backgroundColor: C.bg, borderColor: C.line, borderWidth: 1, borderRadius: 10, color: C.txt, paddingHorizontal: 12, paddingVertical: 10, textAlign: 'right', textAlignVertical: 'top' },
  btn: { borderRadius: 10, minHeight: 48, justifyContent: 'center', alignItems: 'center', marginTop: 14 },
  btnTxt: { color: '#fff', fontWeight: '700', fontSize: 14 },
  outlineBtn: { borderRadius: 10, minHeight: 48, justifyContent: 'center', alignItems: 'center', marginTop: 10, borderWidth: 1, borderColor: C.line },
  segRow: { flexDirection: 'row', gap: 8, marginVertical: 6 },
  seg: { flex: 1, minHeight: 48, justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: C.line, alignItems: 'center', backgroundColor: C.card },
  segOn: { backgroundColor: '#14223a', borderColor: C.fb },
  segTxt: { color: C.txt, fontSize: 13 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  small: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
  item: { flexDirection: 'row', alignItems: 'center', minHeight: 52, borderBottomWidth: 1, borderColor: C.line },
  itemTitle: { color: C.txt, fontSize: 14 },
  bulkBox: { borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 12, marginTop: 14, marginBottom: 6 },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  thumb: { width: 64, height: 64, borderRadius: 8, backgroundColor: C.bg },
  warn: { backgroundColor: '#2a2110', borderColor: '#5a441a', borderWidth: 1, padding: 10, borderRadius: 10, marginTop: 10 },
  pending: { borderWidth: 1, borderColor: C.fb, borderRadius: 12, padding: 14, marginTop: 14, backgroundColor: '#101a2b' },
  preview: { color: C.txt, fontSize: 13, backgroundColor: C.bg, borderRadius: 8, padding: 10, marginTop: 10 },
  countdown: { color: C.fb, fontSize: 40, fontWeight: '700', textAlign: 'center', marginVertical: 8, fontVariant: ['tabular-nums'] },
});
