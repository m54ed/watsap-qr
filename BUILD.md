# بناء APK «مُجدوِل واتساب»

> ⚠️ **مهم:** مكتبة `nodejs-mobile-react-native` (التي تشغّل Baileys داخل الهاتف) **لا تُبنى على ويندوز** — فقط **Linux أو macOS**. الكود مكتمل 100%؛ يبقى فقط بناؤه في بيئة لينكس.

## الطريقة الأسهل: بناء سحابي عبر GitHub Actions (بلا لينكس محلي)
1. أنشئ مستودعاً على GitHub (خاص أو عام).
2. من داخل المجلد:
   ```bash
   git init
   git add .
   git commit -m "WhatsApp Scheduler APK"
   git branch -M main
   git remote add origin https://github.com/<اسمك>/wa-android.git
   git push -u origin main
   ```
3. سيبدأ سير العمل `.github/workflows/build-apk.yml` تلقائياً على لينكس.
4. بعد ~10 دقائق: GitHub ← تبويب **Actions** ← افتح آخر تشغيل ← نزّل **Artifact** باسم `wa-scheduler-apk` (يحتوي ملف APK).
5. انقل الـ APK للهاتف وثبّته (فعّل «مصادر غير معروفة»).

## البديل: بناء محلي على لينكس/ماك (أو WSL على ويندوز)
```bash
npm install
cd nodejs-assets/nodejs-project && npm install --omit=dev --omit=optional && cd ../..
cd android && ./gradlew assembleDebug
# الناتج: android/app/build/outputs/apk/debug/app-debug.apk
```

## لتفعيل WSL على ويندوز (مرة واحدة، يتطلب صلاحيات مدير + إعادة تشغيل)
```powershell
wsl --install
# أعد تشغيل الجهاز، ثم داخل Ubuntu ثبّت: nodejs، JDK 17، Android SDK، ثم نفّذ أوامر البناء المحلي أعلاه.
```

## البنية
- `nodejs-assets/nodejs-project/` — محرّك Node (Baileys + المجدول + التخزين) يعمل داخل الهاتف.
- `src/bridge.ts` + `App.tsx` — واجهة React Native العربية.
- `android/.../NodeForegroundService.kt` — خدمة أمامية دائمة (اتصال دائم في الخلفية).
- `nodejs-assets/BUILD_NATIVE_MODULES.txt` = `0` — تخطّي بناء الوحدات الأصلية (Baileys نقيّ JS).
