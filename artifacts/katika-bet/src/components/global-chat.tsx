import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import { usePrivy } from '@privy-io/react-auth';
import {
  ArrowDown,
  Flame,
  Hash,
  MessageSquare,
  Reply,
  Send,
  Swords,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useKyc } from '@/lib/kyc';
import { useUserAvatar } from '@/lib/avatar';

export type ChatChannel = 'general' | 'markets' | 'pvp';
type ChannelFilter = 'all' | ChatChannel;

interface ChatReaction {
  emoji: string;
  userIds: string[];
}

interface ChatReplyRef {
  id: string;
  senderName: string;
  text: string;
}

interface GlobalChatMessage {
  id: string;
  clientMsgId?: string;
  userId: string;
  senderName: string;
  senderAvatar?: string;
  channel: ChatChannel;
  text: string;
  replyTo?: ChatReplyRef;
  reactions: ChatReaction[];
  createdAt: string;
  pending?: boolean;
}

interface OnlineChatUser {
  userId: string;
  senderName: string;
  senderAvatar?: string;
}

const CHANNEL_META: Record<
  ChatChannel,
  { label: string; colorClass: string; badgeBg: string }
> = {
  general: {
    label: 'General',
    colorClass: 'text-[#4ADE80]',
    badgeBg: 'bg-[#22C55E]/15 border-[#22C55E]/30 text-[#4ADE80]',
  },
  markets: {
    label: 'Markets',
    colorClass: 'text-[#FACC15]',
    badgeBg: 'bg-[#FACC15]/15 border-[#FACC15]/30 text-[#FACC15]',
  },
  pvp: {
    label: 'PvP',
    colorClass: 'text-[#F472B6]',
    badgeBg: 'bg-[#EC4899]/15 border-[#EC4899]/30 text-[#F472B6]',
  },
};

const QUICK_REACTIONS = ['🔥', '🚀', '🎯', '💎'] as const;

const AVATAR_PALETTE = [
  '#22C55E',
  '#38BDF8',
  '#FACC15',
  '#EC4899',
  '#A855F7',
  '#F97316',
];

function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function formatMessageTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function GlobalChatPage() {
  const { authenticated, user, login, getAccessToken } = usePrivy();
  const { record: kycRecord } = useKyc();
  const { avatarUrl } = useUserAvatar();
  const { toast } = useToast();

  const [messages, setMessages] = useState<GlobalChatMessage[]>([]);
  const [onlineCount, setOnlineCount] = useState(0);
  const [onlineUsers, setOnlineUsers] = useState<OnlineChatUser[]>([]);
  const [connState, setConnState] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [activeFilter, setActiveFilter] = useState<ChannelFilter>('all');
  const [composeChannel, setComposeChannel] = useState<ChatChannel>('general');
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<ChatReplyRef | null>(null);
  const [sending, setSending] = useState(false);
  const [showScrollJump, setShowScrollJump] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const pingTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const senderName = useMemo(() => {
    return (
      kycRecord?.fullName?.trim() ||
      user?.google?.name ||
      user?.twitter?.name ||
      user?.farcaster?.displayName ||
      user?.email?.address?.split('@')[0] ||
      (user?.id ? `Trader-${user.id.slice(-4).toUpperCase()}` : 'Trader')
    );
  }, [kycRecord?.fullName, user]);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = feedRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
    stickToBottomRef.current = true;
    setShowScrollJump(false);
  }, []);

  const mergeInitMessages = useCallback((incoming: GlobalChatMessage[]) => {
    setMessages((prev) => {
      const pendingOnly = prev.filter(
        (p) =>
          p.pending &&
          !incoming.some(
            (inc) =>
              inc.id === p.id ||
              (p.clientMsgId && inc.clientMsgId === p.clientMsgId),
          ),
      );
      return [...incoming, ...pendingOnly];
    });
  }, []);

  const upsertIncomingMessage = useCallback((msg: GlobalChatMessage) => {
    setMessages((prev) => {
      const existingIdx = prev.findIndex(
        (m) =>
          m.id === msg.id ||
          (msg.clientMsgId && m.clientMsgId === msg.clientMsgId),
      );
      if (existingIdx >= 0) {
        const next = [...prev];
        next[existingIdx] = { ...msg, pending: false };
        return next;
      }
      return [...prev, { ...msg, pending: false }];
    });
  }, []);

  // Initial HTTP history hydration so chat displays cleanly even before WS handshake settles
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/chat/messages?limit=150')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data && Array.isArray(data.messages)) {
          mergeInitMessages(data.messages);
          if (typeof data.onlineCount === 'number') setOnlineCount(data.onlineCount);
          if (Array.isArray(data.onlineUsers)) setOnlineUsers(data.onlineUsers);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mergeInitMessages]);

  const sendJoinPacket = useCallback(async () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    let token: string | null = null;
    if (authenticated) {
      token = await getAccessToken().catch(() => null);
    }
    ws.send(
      JSON.stringify({
        type: 'chat:join',
        token,
        senderName,
        senderAvatar: avatarUrl || undefined,
      }),
    );
  }, [authenticated, getAccessToken, senderName, avatarUrl]);

  // Persistent real WebSocket connection with automatic reconnect + heartbeat
  useEffect(() => {
    let unmounted = false;

    const connect = () => {
      if (unmounted) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}/ws/chat`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (unmounted) {
          ws.close();
          return;
        }
        reconnectAttemptRef.current = 0;
        setConnState('connected');
        void sendJoinPacket();

        if (pingTimerRef.current) window.clearInterval(pingTimerRef.current);
        pingTimerRef.current = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'chat:ping' }));
          }
        }, 25000);
      };

      ws.onmessage = (ev) => {
        try {
          const payload = JSON.parse(String(ev.data)) as Record<string, unknown>;
          const type = payload.type;

          if (type === 'chat:init') {
            if (Array.isArray(payload.messages)) {
              mergeInitMessages(payload.messages as GlobalChatMessage[]);
            }
            if (typeof payload.onlineCount === 'number') {
              setOnlineCount(payload.onlineCount);
            }
            if (Array.isArray(payload.onlineUsers)) {
              setOnlineUsers(payload.onlineUsers as OnlineChatUser[]);
            }
            return;
          }

          if (type === 'chat:message' && payload.message) {
            upsertIncomingMessage(payload.message as GlobalChatMessage);
            return;
          }

          if (type === 'chat:reaction' && typeof payload.messageId === 'string') {
            const msgId = payload.messageId;
            const reactions = Array.isArray(payload.reactions)
              ? (payload.reactions as ChatReaction[])
              : [];
            setMessages((prev) =>
              prev.map((m) => (m.id === msgId ? { ...m, reactions } : m)),
            );
            return;
          }

          if (type === 'chat:deleted' && typeof payload.messageId === 'string') {
            const msgId = payload.messageId;
            setMessages((prev) => prev.filter((m) => m.id !== msgId));
            return;
          }

          if (type === 'presence:update') {
            if (typeof payload.onlineCount === 'number') {
              setOnlineCount(payload.onlineCount);
            }
            if (Array.isArray(payload.onlineUsers)) {
              setOnlineUsers(payload.onlineUsers as OnlineChatUser[]);
            }
            return;
          }

          if (type === 'chat:error') {
            const clientMsgId =
              typeof payload.clientMsgId === 'string' ? payload.clientMsgId : undefined;
            if (clientMsgId) {
              setMessages((prev) => prev.filter((m) => m.clientMsgId !== clientMsgId));
            }
            toast({
              title: 'Chat Notice',
              description:
                typeof payload.error === 'string'
                  ? payload.error
                  : 'Unable to process chat action.',
              variant: 'destructive',
            });
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        if (pingTimerRef.current) {
          window.clearInterval(pingTimerRef.current);
          pingTimerRef.current = null;
        }
        if (unmounted) return;
        setConnState('reconnecting');
        const attempt = Math.min(reconnectAttemptRef.current + 1, 5);
        reconnectAttemptRef.current = attempt;
        const delay = Math.min(10000, 1000 * Math.pow(1.6, attempt - 1));
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      unmounted = true;
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      if (pingTimerRef.current) window.clearInterval(pingTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [mergeInitMessages, upsertIncomingMessage, sendJoinPacket, toast]);

  // Re-announce presence whenever user logs in or updates display name/avatar
  useEffect(() => {
    void sendJoinPacket();
  }, [sendJoinPacket]);

  const filteredMessages = useMemo(() => {
    if (activeFilter === 'all') return messages;
    return messages.filter((m) => m.channel === activeFilter);
  }, [messages, activeFilter]);

  useEffect(() => {
    if (stickToBottomRef.current) {
      scrollToBottom(false);
    }
  }, [filteredMessages.length, scrollToBottom]);

  const handleFeedScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < 80;
    stickToBottomRef.current = nearBottom;
    setShowScrollJump(!nearBottom);
  };

  const handleFilterChange = (nextFilter: ChannelFilter) => {
    setActiveFilter(nextFilter);
    if (nextFilter !== 'all') {
      setComposeChannel(nextFilter);
    }
    stickToBottomRef.current = true;
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!authenticated) {
      void login();
      return;
    }

    const text = draft.trim();
    if (!text || sending) return;

    const channelToSend: ChatChannel =
      activeFilter === 'all' ? composeChannel : activeFilter;
    const clientMsgId = `cmsg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const optimistic: GlobalChatMessage = {
      id: clientMsgId,
      clientMsgId,
      userId: user?.id || 'me',
      senderName,
      senderAvatar: avatarUrl || undefined,
      channel: channelToSend,
      text,
      ...(replyTo ? { replyTo } : {}),
      reactions: [],
      createdAt: new Date().toISOString(),
      pending: true,
    };

    setDraft('');
    setReplyTo(null);
    stickToBottomRef.current = true;
    setMessages((prev) => [...prev, optimistic]);
    setSending(true);

    try {
      const token = await getAccessToken();
      if (!token) {
        throw new Error('Authentication token unavailable. Please sign in again.');
      }

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'chat:send',
            token,
            clientMsgId,
            text,
            channel: channelToSend,
            senderName,
            senderAvatar: avatarUrl || undefined,
            replyTo: replyTo || undefined,
          }),
        );
      } else {
        const res = await fetch('/api/chat/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            clientMsgId,
            text,
            channel: channelToSend,
            senderName,
            senderAvatar: avatarUrl || undefined,
            replyTo: replyTo || undefined,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error((body as { error?: string }).error || 'Failed to send message.');
        }
        if ((body as { message?: GlobalChatMessage }).message) {
          upsertIncomingMessage((body as { message: GlobalChatMessage }).message);
        }
      }
    } catch (err: any) {
      setMessages((prev) => prev.filter((m) => m.clientMsgId !== clientMsgId));
      setDraft(text);
      toast({
        title: 'Send Failed',
        description: err?.message || 'Could not deliver message.',
        variant: 'destructive',
      });
    } finally {
      setSending(false);
    }
  };

  const handleToggleReaction = async (messageId: string, emoji: string) => {
    if (!authenticated) {
      void login();
      return;
    }
    const token = await getAccessToken().catch(() => null);
    if (!token) return;

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'chat:react',
          token,
          messageId,
          emoji,
        }),
      );
    } else {
      const res = await fetch(`/api/chat/messages/${encodeURIComponent(messageId)}/react`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ emoji }),
      });
      if (res.ok) {
        const body = (await res.json()) as { message?: GlobalChatMessage };
        if (body.message) {
          upsertIncomingMessage(body.message);
        }
      }
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    if (!authenticated) return;
    const token = await getAccessToken().catch(() => null);
    if (!token) return;

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'chat:delete',
          token,
          messageId,
        }),
      );
    } else {
      const res = await fetch(`/api/chat/messages/${encodeURIComponent(messageId)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (res.ok) {
        setMessages((prev) => prev.filter((m) => m.id !== messageId));
      }
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 pt-3 pb-6 lg:px-8 lg:pt-5 space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 rounded-3xl border border-white/[0.08] bg-[#0E1318]/95 p-4 lg:p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-mono">
            <MessageSquare size={14} className="text-[#4ADE80]" />
            <span className="text-[#4ADE80] font-bold uppercase tracking-wider">
              Global Feed
            </span>
            <span className="text-slate-600">·</span>
            <span className="inline-flex items-center gap-1.5 text-slate-300">
              <span
                className={`h-2 w-2 rounded-full ${
                  connState === 'connected'
                    ? 'bg-[#22C55E] animate-pulse'
                    : 'bg-amber-400 animate-pulse'
                }`}
              />
              {connState === 'connected'
                ? 'Live'
                : connState === 'connecting'
                ? 'Connecting...'
                : 'Reconnecting...'}
            </span>
          </div>
          <h1 className="text-xl lg:text-2xl font-extrabold font-display tracking-tight text-white">
            Global Trader Chat
          </h1>
          <p className="text-xs text-slate-400">
            Real-time room for prediction calls, odds discussion, and PvP match challenges.
          </p>
        </div>

        {/* Right Quick Meta: Real Connected Count + Channel Switcher */}
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <div className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-[#080C0F] px-3.5 py-2 text-xs font-mono">
            <Users size={14} className="text-[#4ADE80]" />
            <span className="font-bold text-white tabular-nums">{onlineCount}</span>
            <span className="text-slate-400">Online</span>
          </div>

          <Link
            href="/pvp"
            className="inline-flex items-center gap-1.5 rounded-2xl border border-white/10 bg-[#121820] hover:border-[#22C55E]/40 px-3.5 py-2 text-xs font-semibold text-slate-200 transition-colors"
          >
            <Swords size={14} className="text-[#F472B6]" />
            <span>PvP Lobby</span>
          </Link>
        </div>
      </div>

      {/* Main Split: Feed Column + Desktop Presence Rail */}
      <div className="grid gap-4 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_280px] items-start">
        {/* Chat Card */}
        <div className="flex flex-col rounded-3xl border border-white/[0.08] bg-[#0E1318]/95 shadow-2xl overflow-hidden h-[calc(100vh-17rem)] min-h-[460px] max-h-[760px]">
          {/* Channel Filter Strip */}
          <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] bg-[#0B1015] px-4 py-2.5 overflow-x-auto">
            <div className="flex items-center gap-1.5">
              {(
                [
                  { id: 'all', label: 'All Feed' },
                  { id: 'general', label: 'General' },
                  { id: 'markets', label: 'Markets' },
                  { id: 'pvp', label: 'PvP' },
                ] as const
              ).map((tab) => {
                const active = activeFilter === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => handleFilterChange(tab.id)}
                    className={`inline-flex items-center gap-1 rounded-xl px-3 py-1.5 text-xs font-semibold transition-all whitespace-nowrap shrink-0 ${
                      active
                        ? 'bg-[#22C55E] text-black shadow-sm'
                        : 'text-slate-400 hover:bg-[#121820] hover:text-white'
                    }`}
                  >
                    <Hash size={12} />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            <span className="hidden sm:inline text-[11px] font-mono text-slate-500 whitespace-nowrap shrink-0">
              {filteredMessages.length} {filteredMessages.length === 1 ? 'message' : 'messages'}
            </span>
          </div>

          {/* Scrollable Message Stream */}
          <div
            ref={feedRef}
            onScroll={handleFeedScroll}
            className="relative flex-1 overflow-y-auto px-4 py-4 space-y-3"
          >
            {filteredMessages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center px-4">
                <div className="grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-[#121820] text-[#4ADE80] mb-3">
                  <MessageSquare size={22} />
                </div>
                <h3 className="text-sm font-bold text-white">No messages here yet</h3>
                <p className="mt-1 max-w-xs text-xs text-slate-400 leading-relaxed">
                  Start the conversation — drop your market prediction call or challenge traders to a PvP match.
                </p>
              </div>
            ) : (
              filteredMessages.map((msg) => {
                const isOwn = Boolean(user?.id && msg.userId === user.id);
                const meta = CHANNEL_META[msg.channel] ?? CHANNEL_META.general;
                const tint = colorForUser(msg.userId);
                const initial = (msg.senderName || 'T').charAt(0).toUpperCase();

                return (
                  <div
                    key={msg.id}
                    className={`group rounded-2xl border p-3 transition-colors ${
                      isOwn
                        ? 'border-[#22C55E]/25 bg-[#101C16]/75'
                        : 'border-white/[0.06] bg-[#080C0F]/85 hover:border-white/12'
                    } ${msg.pending ? 'opacity-65' : ''}`}
                  >
                    <div className="flex items-start gap-3">
                      {/* Avatar */}
                      <div className="shrink-0 pt-0.5">
                        {msg.senderAvatar ? (
                          <img
                            src={msg.senderAvatar}
                            alt={msg.senderName}
                            className="h-9 w-9 rounded-full object-cover border border-white/15"
                          />
                        ) : (
                          <div
                            className="grid h-9 w-9 place-items-center rounded-full font-display text-xs font-black text-black"
                            style={{ backgroundColor: tint }}
                          >
                            {initial}
                          </div>
                        )}
                      </div>

                      {/* Body */}
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-xs font-bold text-white truncate">
                              {msg.senderName}
                            </span>
                            {isOwn && (
                              <span className="text-[10px] font-mono font-bold text-[#4ADE80]">
                                (You)
                              </span>
                            )}
                            <span
                              className={`rounded-md border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase ${meta.badgeBg}`}
                            >
                              #{meta.label}
                            </span>
                            <span className="font-mono text-[10px] text-slate-500">
                              {formatMessageTime(msg.createdAt)}
                            </span>
                          </div>

                          {/* Hover / Mobile Actions */}
                          <div className="flex items-center gap-1 opacity-85 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                            <button
                              type="button"
                              title="Reply"
                              onClick={() =>
                                setReplyTo({
                                  id: msg.id,
                                  senderName: msg.senderName,
                                  text: msg.text.slice(0, 120),
                                })
                              }
                              className="grid h-7 w-7 place-items-center rounded-lg border border-white/10 bg-[#121820] text-slate-400 hover:text-white transition-colors"
                            >
                              <Reply size={12} />
                            </button>

                            {QUICK_REACTIONS.slice(0, 2).map((emoji) => (
                              <button
                                key={emoji}
                                type="button"
                                title={`React ${emoji}`}
                                onClick={() => void handleToggleReaction(msg.id, emoji)}
                                className="grid h-7 w-7 place-items-center rounded-lg border border-white/10 bg-[#121820] text-xs hover:border-white/30 transition-colors"
                              >
                                {emoji}
                              </button>
                            ))}

                            {isOwn && !msg.pending && (
                              <button
                                type="button"
                                title="Delete message"
                                onClick={() => void handleDeleteMessage(msg.id)}
                                className="grid h-7 w-7 place-items-center rounded-lg border border-rose-500/20 bg-[#181014] text-rose-400 hover:bg-rose-500/20 transition-colors"
                              >
                                <Trash2 size={12} />
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Optional Quoted Reply */}
                        {msg.replyTo && (
                          <div className="rounded-xl border-l-2 border-[#22C55E] bg-[#121820]/90 px-2.5 py-1.5 text-[11px] text-slate-400">
                            <span className="font-semibold text-slate-200 mr-1.5">
                              @{msg.replyTo.senderName}
                            </span>
                            <span className="line-clamp-1">{msg.replyTo.text}</span>
                          </div>
                        )}

                        <p className="text-xs sm:text-[13px] text-slate-100 leading-relaxed whitespace-pre-wrap break-words">
                          {msg.text}
                        </p>

                        {/* Existing Reactions Row */}
                        {msg.reactions.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5 pt-1">
                            {msg.reactions.map((rx) => {
                              const reacted = Boolean(
                                user?.id && rx.userIds.includes(user.id),
                              );
                              return (
                                <button
                                  key={rx.emoji}
                                  type="button"
                                  onClick={() => void handleToggleReaction(msg.id, rx.emoji)}
                                  className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] font-mono transition-colors ${
                                    reacted
                                      ? 'border-[#22C55E]/50 bg-[#22C55E]/15 text-[#4ADE80]'
                                      : 'border-white/10 bg-[#121820] text-slate-300 hover:border-white/25'
                                  }`}
                                >
                                  <span>{rx.emoji}</span>
                                  <span className="tabular-nums font-bold">
                                    {rx.userIds.length}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}

            {showScrollJump && (
              <button
                type="button"
                onClick={() => scrollToBottom(true)}
                className="sticky bottom-2 ml-auto flex items-center gap-1.5 rounded-full border border-[#22C55E]/40 bg-[#0D1612]/95 px-3 py-1.5 text-[11px] font-bold text-[#4ADE80] shadow-lg backdrop-blur-md"
              >
                <ArrowDown size={12} />
                <span>Latest</span>
              </button>
            )}
          </div>

          {/* Composer Footer */}
          <div className="border-t border-white/[0.06] bg-[#0B1015] p-3 sm:p-4 space-y-2.5">
            {replyTo && (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-[#121820] px-3 py-1.5 text-xs">
                <div className="min-w-0 truncate text-slate-300">
                  <span className="text-[#4ADE80] font-semibold mr-1.5">
                    Replying to {replyTo.senderName}:
                  </span>
                  <span className="text-slate-400">{replyTo.text}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setReplyTo(null)}
                  className="text-slate-400 hover:text-white shrink-0"
                >
                  <X size={14} />
                </button>
              </div>
            )}

            <form onSubmit={handleSend} className="flex items-center gap-2">
              {activeFilter === 'all' && (
                <select
                  value={composeChannel}
                  onChange={(e) => setComposeChannel(e.target.value as ChatChannel)}
                  aria-label="Message channel"
                  className="min-h-[44px] rounded-xl border border-white/10 bg-[#080C0F] px-2.5 text-xs font-semibold text-slate-200 focus:border-[#22C55E] focus:outline-none shrink-0"
                >
                  <option value="general">#General</option>
                  <option value="markets">#Markets</option>
                  <option value="pvp">#PvP</option>
                </select>
              )}

              <input
                type="text"
                maxLength={500}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={
                  authenticated
                    ? `Message #${activeFilter === 'all' ? composeChannel : activeFilter}...`
                    : 'Sign in to join the global chat...'
                }
                className="min-h-[44px] flex-1 rounded-xl border border-white/10 bg-[#080C0F] px-3.5 text-xs sm:text-sm text-white placeholder:text-slate-500 focus:border-[#22C55E] focus:outline-none"
              />

              <button
                type="submit"
                disabled={sending || (authenticated && !draft.trim())}
                className="min-h-[44px] inline-flex items-center gap-1.5 rounded-xl bg-[#22C55E] hover:bg-[#16A34A] px-4 text-xs font-black text-black shadow-md shadow-[#22C55E]/20 transition-all disabled:opacity-45 shrink-0"
              >
                <Send size={14} />
                <span className="hidden sm:inline">{authenticated ? 'Send' : 'Sign In'}</span>
              </button>
            </form>
          </div>
        </div>

        {/* Desktop Presence & Shortcuts Side Panel */}
        <aside className="space-y-4">
          <div className="rounded-3xl border border-white/[0.08] bg-[#0E1318]/95 p-4 space-y-3 shadow-xl">
            <div className="flex items-center justify-between border-b border-white/[0.06] pb-2.5">
              <div className="flex items-center gap-2">
                <Users size={15} className="text-[#4ADE80]" />
                <h2 className="text-sm font-bold text-white">Online Now</h2>
              </div>
              <span className="font-mono text-xs font-bold text-[#4ADE80] tabular-nums">
                {onlineCount}
              </span>
            </div>

            {onlineUsers.length === 0 ? (
              <p className="text-xs text-slate-400">
                Connected traders appear here live as they join the room.
              </p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {onlineUsers.map((u) => (
                  <div
                    key={u.userId}
                    className="flex items-center gap-2.5 rounded-xl border border-white/[0.05] bg-[#080C0F] px-2.5 py-2"
                  >
                    {u.senderAvatar ? (
                      <img
                        src={u.senderAvatar}
                        alt={u.senderName}
                        className="h-7 w-7 rounded-full object-cover"
                      />
                    ) : (
                      <div
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-black text-black"
                        style={{ backgroundColor: colorForUser(u.userId) }}
                      >
                        {u.senderName.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <span className="text-xs font-semibold text-slate-200 truncate">
                      {u.senderName}
                    </span>
                    <span className="ml-auto h-2 w-2 rounded-full bg-[#22C55E] shrink-0" />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-3xl border border-white/[0.08] bg-[#0E1318]/95 p-4 space-y-2.5 shadow-xl">
            <div className="flex items-center gap-1.5 text-xs font-bold text-white">
              <Flame size={14} className="text-[#F472B6]" />
              <span>Jump Back In</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Link
                href="/markets"
                className="rounded-xl border border-white/10 bg-[#080C0F] hover:border-[#22C55E]/40 p-2.5 text-center text-xs font-semibold text-slate-200 transition-colors"
              >
                Markets
              </Link>
              <Link
                href="/pvp"
                className="rounded-xl border border-white/10 bg-[#080C0F] hover:border-[#EC4899]/40 p-2.5 text-center text-xs font-semibold text-slate-200 transition-colors"
              >
                PvP Games
              </Link>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
