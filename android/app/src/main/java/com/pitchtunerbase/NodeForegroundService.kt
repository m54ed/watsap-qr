package com.pitchtunerbase

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * NodeForegroundService — خدمة أمامية تُبقي عملية التطبيق (ومحرّك Baileys داخل nodejs-mobile)
 * حيّة دائماً في الخلفية، فيبقى الاتصال دائماً وتعمل الجدولة حتى لو أُغلقت الواجهة.
 */
class NodeForegroundService : Service() {

  companion object {
    const val CHANNEL_ID = "wa_scheduler_service"
    const val NOTIF_ID = 1337

    fun start(ctx: Context) {
      val i = Intent(ctx, NodeForegroundService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
      else ctx.startService(i)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createChannel()
    goForeground()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    goForeground()
    return START_STICKY // يُعاد تشغيلها إن قتلها النظام
  }

  private fun goForeground() {
    val notif = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIF_ID, notif)
    }
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val ch = NotificationChannel(
        CHANNEL_ID, "خدمة مُجدوِل واتساب", NotificationManager.IMPORTANCE_LOW
      )
      ch.setShowBadge(false)
      (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
        .createNotificationChannel(ch)
    }
  }

  private fun buildNotification(): Notification {
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
      (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
    val pi = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), flags)
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("مُجدوِل واتساب يعمل")
      .setContentText("الاتصال دائم — الجدولة تعمل في الخلفية")
      .setSmallIcon(android.R.drawable.ic_popup_sync)
      .setOngoing(true)
      .setContentIntent(pi)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
  }
}
