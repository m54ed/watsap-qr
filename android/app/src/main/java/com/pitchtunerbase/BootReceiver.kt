package com.pitchtunerbase

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** يُشغّل الخدمة الأمامية تلقائياً عند إقلاع الجهاز. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    if (intent?.action == Intent.ACTION_BOOT_COMPLETED) {
      try { NodeForegroundService.start(context) } catch (_: Exception) {}
    }
  }
}
