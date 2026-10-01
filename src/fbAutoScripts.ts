/**
 * fbAutoScripts.ts — سكربتات تُحقن في صفحة فيسبوك (m.facebook.com) داخل المتصفح الداخلي.
 * كل سكربت ينفّذ خطوة واحدة ويرد بـ postMessage({ step, ok, info }).
 * البحث عن العناصر بالنص/aria-label بالعربي والإنجليزي — لا بأسماء كلاسات (تتغيّر باستمرار).
 */

const HELPERS = `
  function send(o){ try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {} }
  function vis(el){ var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function label(el){ return ((el.getAttribute && el.getAttribute('aria-label')) || el.innerText || el.textContent || '').trim(); }
  function find(re){
    var c = document.querySelectorAll('[role="button"],button,a,[aria-label],[tabindex],[data-sigil]');
    for (var i = 0; i < c.length; i++) {
      var el = c[i], t = label(el);
      if (t && t.length < 90 && re.test(t) && vis(el) && el.getAttribute('aria-disabled') !== 'true' && !el.disabled) return el;
    }
    return null;
  }
  function tap(el){
    el.scrollIntoView({ block: 'center' });
    ['pointerdown','mousedown','touchstart','pointerup','mouseup','touchend'].forEach(function (n) {
      try { el.dispatchEvent(new Event(n, { bubbles: true, cancelable: true })); } catch (e) {}
    });
    el.click();
  }
  function textbox(){
    var c = document.querySelectorAll('textarea:not([readonly]),[contenteditable="true"],[role="textbox"]');
    for (var i = 0; i < c.length; i++) if (vis(c[i])) return c[i];
    return null;
  }
`;

const wrap = (step: string, body: string) =>
  `(function(){ ${HELPERS} try { ${body} } catch (e) { send({ step: '${step}', ok: false, info: 'خطأ: ' + e.message }); } })(); true;`;

// أزرار/نصوص فيسبوك المعروفة (عربي + إنجليزي)
const RE_COMPOSER = "/(write something|what's on your mind|create (a )?(public )?post|اكتب شيئ|اكتب منشور|بم تفكر|إنشاء منشور|انشر شيئ)/i";
const RE_JOIN = '/^(join|join group|انضم|انضمام|(ال)?انضمام (إلى |لل)\\s?المجموعة|انضم (إلى|لل)\\s?المجموعة)$/i';
const RE_POST = '/^(post|نشر|انشر)$/i';

/** هل المستخدم مسجّل دخول؟ وهل هو عضو في القروب؟ */
export const probeScript = () => wrap('probe', `
  var href = location.href;
  var loggedIn = !/\\/login|checkpoint|recover/.test(href) && !document.querySelector('input[name="pass"]');
  var joinBtn = find(${RE_JOIN});
  send({ step: 'probe', ok: true, loggedIn: loggedIn, member: !joinBtn, info: href });
`);

/** يضغط «اكتب شيئاً…» لفتح محرّر المنشور. */
export const openComposerScript = () => wrap('openComposer', `
  var el = find(${RE_COMPOSER});
  if (!el) return send({ step: 'openComposer', ok: false, info: 'لم أجد خانة «اكتب شيئاً»' });
  tap(el);
  send({ step: 'openComposer', ok: true });
`);

/** يكتب النص في المحرّر بطريقة تلتقطها واجهة فيسبوك (أحداث input حقيقية). */
export const fillScript = (text: string) => wrap('fill', `
  var text = ${JSON.stringify(text)};
  var el = textbox();
  if (!el) return send({ step: 'fill', ok: false, info: 'لم أجد مكان كتابة المنشور' });
  el.focus();
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    setter.call(el, text);
  } else {
    var ok = false;
    if (typeof document.execCommand === 'function') {
      document.execCommand('selectAll', false, null);
      ok = document.execCommand('insertText', false, text); // يمر عبر محرّر فيسبوك كأنه كتابة حقيقية
    }
    if (!ok) el.textContent = text;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  var got = (el.value != null ? el.value : el.innerText) || '';
  var probe = text.trim().slice(0, 20);
  send({ step: 'fill', ok: got.indexOf(probe) !== -1, info: got.indexOf(probe) !== -1 ? '' : 'النص لم يُكتب في المحرّر' });
`);

/** يضغط زر «نشر». */
export const postScript = () => wrap('post', `
  var el = find(${RE_POST});
  if (!el) return send({ step: 'post', ok: false, info: 'لم أجد زر «نشر» (قد يكون معطّلاً)' });
  tap(el);
  send({ step: 'post', ok: true });
`);

/** بعد النشر: المحرّر يُغلق أو يفرغ — وإلا فالنشر لم يتم. */
export const verifyScript = (text: string) => wrap('verify', `
  var probe = ${JSON.stringify(text.trim().slice(0, 20))};
  var el = textbox();
  var still = el && ((el.value != null ? el.value : el.innerText) || '').indexOf(probe) !== -1;
  send({ step: 'verify', ok: !still, info: still ? 'المنشور ما زال في المحرّر — ربما لم يُنشر' : '' });
`);
