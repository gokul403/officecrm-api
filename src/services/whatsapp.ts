const WHATSAPP_ENABLED = process.env.WHATSAPP_ENABLED === "true";
const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL?.replace(/\/$/, "") ?? "";
const WHATSAPP_API_KEY = process.env.WHATSAPP_API_KEY ?? "";
const WHATSAPP_SESSION_ID = process.env.WHATSAPP_SESSION_ID ?? "";

function maskSecret(value: string): string {
  if (!value) return "(empty)";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 6)}…${value.slice(-4)} (len=${value.length})`;
}

export type TaskForNotification = {
  title: string;
  priority?: string | null;
  due_date?: string | Date | null;
};

function formatDueDate(dueDate: string | Date | null | undefined): string {
  if (!dueDate) return "Not set";
  const date = dueDate instanceof Date ? dueDate : new Date(dueDate);
  if (Number.isNaN(date.getTime())) return "Not set";
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function buildTaskAssignedMessage(task: TaskForNotification, assignerName: string): string {
  const priority = task.priority ?? "medium";
  const dueDate = formatDueDate(task.due_date);
  return [
    `📋 New task assigned to you: "${task.title}"`,
    `Priority: ${priority} | Due: ${dueDate}`,
    `Assigned by: ${assignerName}`,
  ].join("\n");
}

export type LeadForNotification = {
  name: string;
  company?: string | null;
  source?: string | null;
  status?: string | null;
  notes?: string | null;
  expected_revenue?: string | number | null;
  followup_date?: string | Date | null;
  assignee_name?: string | null;
};

export function buildLeadCreatedMessage(lead: LeadForNotification, creatorName: string): string {
  const lines = [
    `🆕 New lead created: "${lead.name}"`,
    `Status: ${lead.status ?? "new"}`,
  ];
  if (lead.company) lines.push(`Company: ${lead.company}`);
  if (lead.source) lines.push(`Source: ${lead.source}`);
  if (lead.assignee_name) lines.push(`Assigned to: ${lead.assignee_name}`);
  if (lead.expected_revenue != null && lead.expected_revenue !== "") {
    lines.push(`Expected revenue: ${lead.expected_revenue}`);
  }
  if (lead.followup_date) {
    lines.push(`Follow-up: ${formatDueDate(lead.followup_date)}`);
  }
  if (lead.notes) {
    const notes = lead.notes.length > 120 ? `${lead.notes.slice(0, 117)}…` : lead.notes;
    lines.push(`Notes: ${notes}`);
  }
  lines.push(`Created by: ${creatorName}`);
  return lines.join("\n");
}

/** Digits-only phone for matching WhatsApp JIDs to profiles.phone */
export function normalizePhoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * Profiles store local numbers without country code. WhatsApp often sends `91…`.
 * Strip a leading `91` when the value is longer than a local number (10 digits).
 */
export function toLocalPhoneDigits(phone: string): string {
  const digits = normalizePhoneDigits(phone);
  if (digits.startsWith("91") && digits.length > 10) {
    return digits.slice(2);
  }
  return digits;
}

/** True when two phone strings refer to the same local number (handles optional leading 91). */
export function phonesMatchLocal(a: string, b: string): boolean {
  const left = toLocalPhoneDigits(a);
  const right = toLocalPhoneDigits(b);
  if (!left || !right) return false;
  return left === right;
}

/**
 * Digits for outbound WhatsApp JIDs. Profiles store 10-digit local numbers;
 * WhatsApp expects India MSISDN with country code (91…).
 */
export function toWhatsAppMsisdnDigits(phone: string): string | null {
  const local = toLocalPhoneDigits(phone);
  if (!local) return null;
  if (local.length === 10) {
    return `91${local}`;
  }
  const raw = normalizePhoneDigits(phone);
  return raw || null;
}

/** Build `…@c.us` for proactive sends (task/lead notify). Always uses country-coded MSISDN when local is 10 digits. */
export function normalizePhoneToChatId(phone: string): string | null {
  const msisdn = toWhatsAppMsisdnDigits(phone);
  if (!msisdn) return null;
  return `${msisdn}@c.us`;
}

/** Extract digits from a WhatsApp chatId like `91…@c.us` or `…@s.whatsapp.net` */
export function chatIdToPhoneDigits(chatId: string): string | null {
  const local = chatId.split("@")[0] ?? "";
  const digits = normalizePhoneDigits(local);
  return digits || null;
}

export function isLidJid(jid: string | null | undefined): boolean {
  if (!jid) return false;
  return jid.includes("@lid");
}

/**
 * Reply on the inbound chat when it is @lid (LID-migrated contacts).
 * Otherwise use a phone @c.us JID.
 */
function resolveReplyChatId(rawChatId: string, phoneDigits: string | null): string {
  if (rawChatId && isLidJid(rawChatId)) return rawChatId;
  if (phoneDigits) return `${phoneDigits}@c.us`;
  return rawChatId;
}

/**
 * Prefer real MSISDN from OpenWA LID resolution for profile matching;
 * never treat @lid local-part as a phone. Reply on @lid when inbound was @lid.
 */
export function resolveWhatsAppSenderIdentity(input: {
  from?: string | null;
  chatId?: string | null;
  author?: string | null;
  senderPhone?: string | null;
  senderPn?: string | null;
  contactNumber?: string | null;
}): {
  rawChatId: string;
  matchPhoneDigits: string | null;
  replyChatId: string;
  source: "senderPhone" | "contactNumber" | "senderPn" | "phoneJid" | "lidFallback" | "none";
} {
  const rawChatId = (input.chatId || input.from || "").trim();
  const senderPhoneDigits = input.senderPhone ? normalizePhoneDigits(String(input.senderPhone)) : "";
  const contactDigits = input.contactNumber ? normalizePhoneDigits(String(input.contactNumber)) : "";
  const senderPnDigits = input.senderPn ? chatIdToPhoneDigits(String(input.senderPn)) : null;

  if (senderPhoneDigits) {
    return {
      rawChatId,
      // Local digits for profiles.phone (no country code)
      matchPhoneDigits: toLocalPhoneDigits(senderPhoneDigits),
      replyChatId: resolveReplyChatId(rawChatId, senderPhoneDigits),
      source: "senderPhone",
    };
  }

  if (contactDigits) {
    return {
      rawChatId,
      matchPhoneDigits: toLocalPhoneDigits(contactDigits),
      replyChatId: resolveReplyChatId(rawChatId, contactDigits),
      source: "contactNumber",
    };
  }

  if (senderPnDigits && !isLidJid(input.senderPn)) {
    return {
      rawChatId,
      matchPhoneDigits: toLocalPhoneDigits(senderPnDigits),
      replyChatId: resolveReplyChatId(rawChatId, senderPnDigits),
      source: "senderPn",
    };
  }

  const phoneJid = [input.from, input.chatId, input.author].find(
    (j) => j && !isLidJid(j) && (j.includes("@c.us") || j.includes("@s.whatsapp.net"))
  );
  if (phoneJid) {
    const digits = chatIdToPhoneDigits(phoneJid);
    if (digits) {
      return {
        rawChatId,
        matchPhoneDigits: toLocalPhoneDigits(digits),
        replyChatId: resolveReplyChatId(rawChatId, digits),
        source: "phoneJid",
      };
    }
  }

  // LID inbound with no resolved phone — can reply, but cannot match a profile
  if (rawChatId && isLidJid(rawChatId)) {
    return {
      rawChatId,
      matchPhoneDigits: null,
      replyChatId: rawChatId,
      source: "lidFallback",
    };
  }

  const fallbackDigits = rawChatId ? chatIdToPhoneDigits(rawChatId) : null;
  return {
    rawChatId,
    matchPhoneDigits: fallbackDigits ? toLocalPhoneDigits(fallbackDigits) : null,
    replyChatId: resolveReplyChatId(rawChatId, fallbackDigits),
    source: fallbackDigits ? "phoneJid" : "none",
  };
}

const SEND_MIN_DELAY_MS = Number(process.env.WHATSAPP_SEND_MIN_DELAY_MS ?? 3000);
const SEND_JITTER_MS = Number(process.env.WHATSAPP_SEND_JITTER_MS ?? 2000);

type QueuedSend = { chatId: string; message: string; resolve: () => void };
const sendQueue: QueuedSend[] = [];
let queueRunning = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function drainSendQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  while (sendQueue.length > 0) {
    const item = sendQueue.shift()!;
    await postSendText(item.chatId, item.message);
    item.resolve();
    if (sendQueue.length > 0) {
      await sleep(SEND_MIN_DELAY_MS + Math.random() * SEND_JITTER_MS);
    }
  }
  queueRunning = false;
}

function enqueueSend(chatId: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    sendQueue.push({ chatId, message, resolve });
    void drainSendQueue();
  });
}

async function postSendText(chatId: string, message: string): Promise<void> {
  console.log("[WhatsApp] sendToChatId called", {
    enabled: WHATSAPP_ENABLED,
    apiUrl: WHATSAPP_API_URL || "(empty)",
    apiKey: maskSecret(WHATSAPP_API_KEY),
    sessionId: WHATSAPP_SESSION_ID || "(empty)",
    chatId,
    messagePreview: message.slice(0, 80) + (message.length > 80 ? "…" : ""),
  });

  if (!WHATSAPP_ENABLED) {
    console.log("[WhatsApp] Skipped (WHATSAPP_ENABLED is not true)");
    return;
  }

  if (!WHATSAPP_API_URL || !WHATSAPP_API_KEY) {
    console.warn("[WhatsApp] Skipped (WHATSAPP_API_URL or WHATSAPP_API_KEY not configured)", {
      hasUrl: Boolean(WHATSAPP_API_URL),
      hasKey: Boolean(WHATSAPP_API_KEY),
    });
    return;
  }

  if (!WHATSAPP_SESSION_ID) {
    console.warn("[WhatsApp] Skipped (WHATSAPP_SESSION_ID not configured)");
    return;
  }

  if (!chatId) {
    console.warn("[WhatsApp] Skipped (empty chatId)");
    return;
  }

  const url = `${WHATSAPP_API_URL}/api/sessions/${encodeURIComponent(WHATSAPP_SESSION_ID)}/messages/send-text`;
  const payload = { chatId, text: message };

  console.log("[WhatsApp] POST send-text", { url, chatId, textLength: message.length });

  const controller = new AbortController();
  const timeoutMs = Number(process.env.WHATSAPP_SEND_TIMEOUT_MS ?? 25000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const startedAt = Date.now();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": WHATSAPP_API_KEY,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const elapsedMs = Date.now() - startedAt;
    const body = await response.text().catch(() => "");

    if (!response.ok) {
      console.error("[WhatsApp] send-text failed", {
        status: response.status,
        statusText: response.statusText,
        elapsedMs,
        body: body.slice(0, 1000),
        chatId,
        sessionId: WHATSAPP_SESSION_ID,
      });
      return;
    }

    console.log("[WhatsApp] Message sent successfully", {
      status: response.status,
      elapsedMs,
      chatId,
      responseBody: body.slice(0, 500),
    });
  } catch (error) {
    console.error("[WhatsApp] send-text network/error", {
      chatId,
      url,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Send to an explicit WhatsApp JID (`…@c.us`, `…@lid`, etc.). */
export async function sendWhatsAppToChatId(chatId: string, message: string): Promise<void> {
  await enqueueSend(chatId, message);
}

export async function sendWhatsAppMessage(phone: string, message: string): Promise<void> {
  const chatId = normalizePhoneToChatId(phone);
  if (!chatId) {
    console.warn("[WhatsApp] Skipped (invalid phone number)", { phone });
    return;
  }
  console.log("[WhatsApp] Resolved outbound chatId", {
    phoneRaw: phone,
    chatId,
  });
  await enqueueSend(chatId, message);
}
