'use client'

import { HubPageHeader } from '@/components/Layout/HubPageHeader'
import { useNotifications } from '@/contexts/NotificationProvider'
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '@/services/notificationService'
import { listConversations } from '@/services/conversationService'
import { registerPushSubscription } from '@/services/pushClient'
import cn from 'classnames'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { HiBell, HiChatBubbleLeftRight } from 'react-icons/hi2'

type NotifRow = {
  _id: string
  kind?: string
  title: string
  body: string
  link?: string
  payload?: { status?: string } | null
  isRead?: boolean
  createdAt?: string
}

function isRejectionAlert(n: NotifRow): boolean {
  return n.kind === 'submission_outcome' && n.payload?.status === 'rejected'
}

export default function InboxPage() {
  const { refreshUnread } = useNotifications()
  const [tab, setTab] = useState<'notifications' | 'messages'>('notifications')
  const [items, setItems] = useState<NotifRow[]>([])
  const [conversations, setConversations] = useState<
    Array<{
      conversationId: string
      submissionId: string
      lastMessagePreview?: string
      lastMessageAt?: string
    }>
  >([])
  const [loading, setLoading] = useState(true)

  const loadNotifs = useCallback(async () => {
    try {
      const res = await fetchNotifications(1, 40)
      const envelope = res.data as {
        data?: { items?: NotifRow[] }
      }
      setItems(envelope.data?.items ?? [])
    } catch {
      toast.error('Could not load notifications')
    }
  }, [])

  const loadConvos = useCallback(async () => {
    try {
      const res = await listConversations()
      const envelope = res.data as {
        data?: {
          conversations?: Array<{
            conversationId: string
            submissionId: string
            lastMessagePreview?: string
            lastMessageAt?: string
          }>
        }
      }
      setConversations(envelope.data?.conversations ?? [])
    } catch {
      toast.error('Could not load messages')
    }
  }, [])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      await Promise.all([loadNotifs(), loadConvos()])
      setLoading(false)
    })()
  }, [loadNotifs, loadConvos])

  const onOpenNotif = async (n: NotifRow) => {
    try {
      if (!n.isRead) {
        await markNotificationRead(n._id)
        await refreshUnread()
        setItems(prev =>
          prev.map(x => (x._id === n._id ? { ...x, isRead: true } : x)),
        )
      }
      if (n.link) {
        window.location.href = n.link
      }
    } catch {
      /* ignore */
    }
  }

  const enablePush = async () => {
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
        toast.error('Notifications blocked in browser settings')
        return
      }
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        await Notification.requestPermission()
      }
      const ok = await registerPushSubscription()
      toast.success(ok ? 'Push enabled' : 'Push not available')
    } catch {
      toast.error('Push setup failed')
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#faf9f6] px-4 pb-28 pt-3">
      <HubPageHeader title="Inbox" subtitle="Alerts & DMs" />

      <div className="mb-4 rounded-2xl border border-[#435F24]/15 bg-[#eef6e4] px-4 py-3 text-sm text-[#374151]">
        <p className="font-semibold text-[#111827]">Stay in the loop</p>
        <p className="mt-1 text-xs text-[#6b7280]">
          Get notified when verifiers review your clips or rewards land.
        </p>
        <button
          type="button"
          className="tg-cta mt-3 w-full py-2.5 text-sm"
          onClick={() => void enablePush()}
        >
          Enable push notifications
        </button>
      </div>

      <div className="mb-4 flex rounded-2xl bg-white p-1 shadow-sm ring-1 ring-black/5">
        <button
          type="button"
          className={cn(
            'flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold transition-colors',
            tab === 'notifications'
              ? 'bg-[#435F24] text-white'
              : 'text-[#6b7280]',
          )}
          onClick={() => setTab('notifications')}
        >
          <HiBell className="h-5 w-5" />
          Alerts
        </button>
        <button
          type="button"
          className={cn(
            'flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold transition-colors',
            tab === 'messages'
              ? 'bg-[#435F24] text-white'
              : 'text-[#6b7280]',
          )}
          onClick={() => setTab('messages')}
        >
          <HiChatBubbleLeftRight className="h-5 w-5" />
          Messages
        </button>
      </div>

      {tab === 'notifications' ? (
        <div className="space-y-2">
          <div className="flex justify-end">
            <button
              type="button"
              className="text-xs font-semibold text-[#435F24] underline"
              onClick={async () => {
                await markAllNotificationsRead()
                await refreshUnread()
                await loadNotifs()
              }}
            >
              Mark all read
            </button>
          </div>
          {loading ? (
            <p className="text-center text-sm text-[#6b6560]">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-center text-sm text-[#6b6560]">
              No notifications yet.
            </p>
          ) : (
            items.map(n => (
              <button
                key={n._id}
                type="button"
                onClick={() => void onOpenNotif(n)}
                className={cn(
                  'tg-card w-full border px-4 py-3 text-left transition-transform active:scale-[0.99]',
                  n.isRead ? 'opacity-75' : 'border-[#dfea8a]/80 bg-white',
                  isRejectionAlert(n) &&
                    'border-l-4 border-l-red-500 bg-red-50/60',
                )}
              >
                <p
                  className={cn(
                    'font-semibold',
                    isRejectionAlert(n) ? 'text-red-900' : 'text-[#111827]',
                  )}
                >
                  {n.title}
                </p>
                <p className="mt-1 text-sm text-[#4b5563]">{n.body}</p>
                {n.createdAt ? (
                  <p className="mt-2 text-[11px] text-[#9ca3af]">
                    {new Date(n.createdAt).toLocaleString()}
                  </p>
                ) : null}
              </button>
            ))
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {loading ? (
            <p className="text-center text-sm text-[#6b6560]">Loading…</p>
          ) : conversations.length === 0 ? (
            <p className="text-center text-sm text-[#6b6560]">
              No conversations yet — open a submission to chat.
            </p>
          ) : (
            conversations.map(c => (
              <Link
                key={c.conversationId}
                href={`/submissions/${encodeURIComponent(c.submissionId)}`}
                className="tg-card block border px-4 py-3 active:scale-[0.99]"
              >
                <p className="text-xs font-mono text-[#9ca3af]">
                  Submission {c.submissionId.slice(-6)}
                </p>
                <p className="mt-1 line-clamp-2 text-sm text-[#374151]">
                  {c.lastMessagePreview || 'Open thread'}
                </p>
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  )
}
