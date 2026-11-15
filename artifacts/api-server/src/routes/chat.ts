import crypto from "crypto";
import fs from "fs";
import type { Server as HttpServer } from "http";
import path from "path";
import { Router, type IRouter, type Request, type Response } from "express";
import { WebSocket, WebSocketServer } from "ws";
import {
  AuthConfigError,
  AuthError,
  authenticateRequest,
  verifyAccessToken,
} from "../lib/privy-auth";

const router: IRouter = Router();

export type ChatChannel = "general" | "markets" | "pvp";

export interface ChatReaction {
  emoji: string;
  userIds: string[];
}

export interface ChatReplyRef {
  id: string;
  senderName: string;
  text: string;
}

export interface GlobalChatMessage {
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
}

export interface OnlineChatUser {
  userId: string;
  senderName: string;
  senderAvatar?: string;
}

interface SocketMeta {
  userId?: string;
  senderName: string;
  senderAvatar?: string;
}

const VALID_CHANNELS = new Set<ChatChannel>(["general", "markets", "pvp"]);
const ALLOWED_REACTIONS = new Set(["🔥", "🚀", "🎯", "💎", "👏"]);
const MAX_STORED_MESSAGES = 200;
const MAX_MESSAGE_LENGTH = 500;

const DATA_DIR = path.resolve(process.cwd(), ".data");
const CHAT_FILE = path.join(DATA_DIR, "sidebet_global_chat.json");

let messagesList: GlobalChatMessage[] = [];
const lastSentAtByUser = new Map<string, number>();

function loadChatMessages(): GlobalChatMessage[] {
  try {
    if (fs.existsSync(CHAT_FILE)) {
      const raw = fs.readFileSync(CHAT_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.slice(-MAX_STORED_MESSAGES);
      }
    }
  } catch (err) {
    console.warn("Failed to read sidebet_global_chat.json:", err);
  }
  return [];
}

function persistChatMessages() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(
      CHAT_FILE,
      JSON.stringify(messagesList.slice(-MAX_STORED_MESSAGES), null, 2),
      "utf-8",
    );
  } catch (err) {
    console.warn("Failed to persist sidebet_global_chat.json:", err);
  }
}

messagesList = loadChatMessages();

// WebSocket registry & helpers
let wss: WebSocketServer | null = null;
const socketMeta = new Map<WebSocket, SocketMeta>();

function sanitizeName(raw: unknown, fallbackId?: string): string {
  if (typeof raw === "string") {
    const clean = raw.trim().replace(/\s+/g, " ").slice(0, 36);
    if (clean.length >= 2) return clean;
  }
  if (fallbackId) {
    const suffix = fallbackId.slice(-4).toUpperCase();
    return `Trader-${suffix}`;
  }
  return "Trader";
}

function sanitizeAvatar(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("data:image/")
  ) {
    return trimmed.slice(0, 120000);
  }
  return undefined;
}

function sanitizeChannel(raw: unknown): ChatChannel {
  if (typeof raw === "string" && VALID_CHANNELS.has(raw as ChatChannel)) {
    return raw as ChatChannel;
  }
  return "general";
}

function getPresenceSnapshot(): {
  onlineCount: number;
  onlineUsers: OnlineChatUser[];
} {
  const uniqueByUser = new Map<string, OnlineChatUser>();
  let anonymousCount = 0;

  socketMeta.forEach((meta, ws) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (meta.userId) {
      uniqueByUser.set(meta.userId, {
        userId: meta.userId,
        senderName: meta.senderName,
        senderAvatar: meta.senderAvatar,
      });
    } else {
      anonymousCount += 1;
    }
  });

  const onlineUsers = Array.from(uniqueByUser.values());
  return {
    onlineCount: onlineUsers.length + anonymousCount,
    onlineUsers,
  };
}

function sendJson(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastEvent(payload: unknown) {
  const serialized = JSON.stringify(payload);
  socketMeta.forEach((_meta, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serialized);
    }
  });
}

function broadcastPresence() {
  const presence = getPresenceSnapshot();
  broadcastEvent({
    type: "presence:update",
    ...presence,
  });
}

function createOrDedupeMessage(params: {
  userId: string;
  senderName?: unknown;
  senderAvatar?: unknown;
  text: unknown;
  channel?: unknown;
  clientMsgId?: unknown;
  replyTo?: unknown;
}): { message: GlobalChatMessage; created: boolean } {
  const rawText = typeof params.text === "string" ? params.text.trim() : "";
  if (!rawText) {
    throw new Error("Message cannot be empty.");
  }
  if (rawText.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Message exceeds ${MAX_MESSAGE_LENGTH} characters.`);
  }

  const clientMsgId =
    typeof params.clientMsgId === "string" && params.clientMsgId.trim()
      ? params.clientMsgId.trim().slice(0, 80)
      : undefined;

  if (clientMsgId) {
    const existing = messagesList.find(
      (m) => m.clientMsgId === clientMsgId && m.userId === params.userId,
    );
    if (existing) {
      return { message: existing, created: false };
    }
  }

  const now = Date.now();
  const prevSent = lastSentAtByUser.get(params.userId) ?? 0;
  if (now - prevSent < 400) {
    throw new Error("You are sending messages too fast. Wait a moment.");
  }
  lastSentAtByUser.set(params.userId, now);

  let replyRef: ChatReplyRef | undefined;
  if (
    params.replyTo &&
    typeof params.replyTo === "object" &&
    typeof (params.replyTo as { id?: unknown }).id === "string"
  ) {
    const target = messagesList.find(
      (m) => m.id === (params.replyTo as { id: string }).id,
    );
    if (target) {
      replyRef = {
        id: target.id,
        senderName: target.senderName,
        text: target.text.slice(0, 120),
      };
    }
  }

  const message: GlobalChatMessage = {
    id: `msg-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    clientMsgId,
    userId: params.userId,
    senderName: sanitizeName(params.senderName, params.userId),
    senderAvatar: sanitizeAvatar(params.senderAvatar),
    channel: sanitizeChannel(params.channel),
    text: rawText,
    ...(replyRef ? { replyTo: replyRef } : {}),
    reactions: [],
    createdAt: new Date().toISOString(),
  };

  messagesList.push(message);
  if (messagesList.length > MAX_STORED_MESSAGES) {
    messagesList = messagesList.slice(-MAX_STORED_MESSAGES);
  }
  persistChatMessages();

  return { message, created: true };
}

function toggleMessageReaction(params: {
  messageId: string;
  userId: string;
  emoji: string;
}): GlobalChatMessage {
  if (!ALLOWED_REACTIONS.has(params.emoji)) {
    throw new Error("Unsupported reaction emoji.");
  }
  const msg = messagesList.find((m) => m.id === params.messageId);
  if (!msg) {
    throw new Error("Message not found.");
  }

  const existing = msg.reactions.find((r) => r.emoji === params.emoji);
  if (!existing) {
    msg.reactions.push({ emoji: params.emoji, userIds: [params.userId] });
  } else {
    const idx = existing.userIds.indexOf(params.userId);
    if (idx >= 0) {
      existing.userIds.splice(idx, 1);
      if (existing.userIds.length === 0) {
        msg.reactions = msg.reactions.filter((r) => r.emoji !== params.emoji);
      }
    } else {
      existing.userIds.push(params.userId);
    }
  }

  persistChatMessages();
  return msg;
}

function deleteOwnMessage(params: { messageId: string; userId: string }): boolean {
  const idx = messagesList.findIndex((m) => m.id === params.messageId);
  if (idx === -1) return false;
  if (messagesList[idx].userId !== params.userId) {
    throw new Error("You can only delete your own messages.");
  }
  messagesList.splice(idx, 1);
  persistChatMessages();
  return true;
}

export function attachChatWebSocket(httpServer: HttpServer) {
  if (wss) return wss;

  wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const rawUrl = req.url ?? "";
    const pathname = rawUrl.split("?")[0];
    if (pathname !== "/ws/chat") {
      return;
    }

    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    socketMeta.set(ws, { senderName: "Viewer" });

    const presence = getPresenceSnapshot();
    sendJson(ws, {
      type: "chat:init",
      messages: messagesList.slice(-MAX_STORED_MESSAGES),
      ...presence,
    });
    broadcastPresence();

    ws.on("message", async (raw) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        sendJson(ws, { type: "chat:error", error: "Invalid message payload." });
        return;
      }

      const eventType = data.type;

      if (eventType === "chat:ping") {
        sendJson(ws, { type: "chat:pong", ts: Date.now() });
        return;
      }

      if (eventType === "chat:join") {
        const token = typeof data.token === "string" ? data.token : "";
        let verifiedUserId = socketMeta.get(ws)?.userId;
        if (token) {
          try {
            const identity = await verifyAccessToken(token);
            verifiedUserId = identity.privyUserId;
          } catch {
            // Keep unauthenticated viewer if token verification fails
          }
        }
        socketMeta.set(ws, {
          userId: verifiedUserId,
          senderName: sanitizeName(data.senderName, verifiedUserId),
          senderAvatar: sanitizeAvatar(data.senderAvatar),
        });
        broadcastPresence();
        return;
      }

      if (eventType === "chat:send") {
        const clientMsgId =
          typeof data.clientMsgId === "string" ? data.clientMsgId : undefined;
        try {
          let userId = socketMeta.get(ws)?.userId;
          const token = typeof data.token === "string" ? data.token : "";
          if (!userId || token) {
            if (!token) {
              throw new AuthError("Sign in required to send messages.");
            }
            const identity = await verifyAccessToken(token);
            userId = identity.privyUserId;
            socketMeta.set(ws, {
              userId,
              senderName: sanitizeName(
                data.senderName ?? socketMeta.get(ws)?.senderName,
                userId,
              ),
              senderAvatar:
                sanitizeAvatar(data.senderAvatar) ?? socketMeta.get(ws)?.senderAvatar,
            });
            broadcastPresence();
          }

          const currentMeta = socketMeta.get(ws);
          const { message, created } = createOrDedupeMessage({
            userId,
            senderName: data.senderName ?? currentMeta?.senderName,
            senderAvatar: data.senderAvatar ?? currentMeta?.senderAvatar,
            text: data.text,
            channel: data.channel,
            clientMsgId,
            replyTo: data.replyTo,
          });

          if (created) {
            broadcastEvent({ type: "chat:message", message });
          } else {
            sendJson(ws, { type: "chat:message", message });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "Failed to send message.";
          sendJson(ws, { type: "chat:error", error: msg, clientMsgId });
        }
        return;
      }

      if (eventType === "chat:react") {
        try {
          let userId = socketMeta.get(ws)?.userId;
          const token = typeof data.token === "string" ? data.token : "";
          if (!userId) {
            if (!token) throw new AuthError("Sign in required to react.");
            const identity = await verifyAccessToken(token);
            userId = identity.privyUserId;
          }
          const messageId =
            typeof data.messageId === "string" ? data.messageId : "";
          const emoji = typeof data.emoji === "string" ? data.emoji : "";
          const updated = toggleMessageReaction({ messageId, userId, emoji });
          broadcastEvent({
            type: "chat:reaction",
            messageId: updated.id,
            reactions: updated.reactions,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "Failed to toggle reaction.";
          sendJson(ws, { type: "chat:error", error: msg });
        }
        return;
      }

      if (eventType === "chat:delete") {
        try {
          let userId = socketMeta.get(ws)?.userId;
          const token = typeof data.token === "string" ? data.token : "";
          if (!userId) {
            if (!token) throw new AuthError("Sign in required.");
            const identity = await verifyAccessToken(token);
            userId = identity.privyUserId;
          }
          const messageId =
            typeof data.messageId === "string" ? data.messageId : "";
          const removed = deleteOwnMessage({ messageId, userId });
          if (removed) {
            broadcastEvent({ type: "chat:deleted", messageId });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "Failed to delete message.";
          sendJson(ws, { type: "chat:error", error: msg });
        }
      }
    });

    ws.on("close", () => {
      socketMeta.delete(ws);
      broadcastPresence();
    });

    ws.on("error", () => {
      socketMeta.delete(ws);
      broadcastPresence();
    });
  });

  return wss;
}

function handleAuthError(res: Response, error: unknown) {
  if (error instanceof AuthConfigError) {
    return res.status(503).json({ error: error.message });
  }
  if (error instanceof AuthError) {
    return res.status(401).json({ error: error.message });
  }
  return res.status(400).json({
    error: error instanceof Error ? error.message : "Chat request failed",
  });
}

// REST GET /api/chat/messages - Initial history + presence snapshot
router.get("/chat/messages", (req: Request, res: Response) => {
  const { channel, limit } = req.query;
  let filtered = messagesList;

  if (
    typeof channel === "string" &&
    channel !== "all" &&
    VALID_CHANNELS.has(channel as ChatChannel)
  ) {
    filtered = filtered.filter((m) => m.channel === channel);
  }

  const maxCount = Math.min(200, Math.max(1, Number(limit) || 120));
  const presence = getPresenceSnapshot();

  return res.json({
    success: true,
    messages: filtered.slice(-maxCount),
    ...presence,
  });
});

// REST POST /api/chat/messages - Authenticated HTTP fallback that broadcasts over WS
router.post("/chat/messages", async (req: Request, res: Response) => {
  try {
    const identity = await authenticateRequest(req);
    const { text, channel, clientMsgId, senderName, senderAvatar, replyTo } =
      req.body ?? {};
    const { message, created } = createOrDedupeMessage({
      userId: identity.privyUserId,
      senderName,
      senderAvatar,
      text,
      channel,
      clientMsgId,
      replyTo,
    });

    if (created) {
      broadcastEvent({ type: "chat:message", message });
    }

    return res.status(created ? 201 : 200).json({
      success: true,
      message,
    });
  } catch (error) {
    return handleAuthError(res, error);
  }
});

// REST POST /api/chat/messages/:id/react
router.post("/chat/messages/:id/react", async (req: Request, res: Response) => {
  try {
    const identity = await authenticateRequest(req);
    const { emoji } = req.body ?? {};
    const updated = toggleMessageReaction({
      messageId: String(req.params.id),
      userId: identity.privyUserId,
      emoji: String(emoji || ""),
    });
    broadcastEvent({
      type: "chat:reaction",
      messageId: updated.id,
      reactions: updated.reactions,
    });
    return res.json({ success: true, message: updated });
  } catch (error) {
    return handleAuthError(res, error);
  }
});

// REST DELETE /api/chat/messages/:id
router.delete("/chat/messages/:id", async (req: Request, res: Response) => {
  try {
    const identity = await authenticateRequest(req);
    const messageId = String(req.params.id);
    const removed = deleteOwnMessage({
      messageId,
      userId: identity.privyUserId,
    });
    if (removed) {
      broadcastEvent({ type: "chat:deleted", messageId });
    }
    return res.json({ success: true, deleted: removed });
  } catch (error) {
    return handleAuthError(res, error);
  }
});

export default router;
