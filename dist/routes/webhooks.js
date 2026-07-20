import crypto from "crypto";
import { chatIdToPhoneDigits, isLidJid, resolveWhatsAppSenderIdentity, } from "../services/whatsapp.js";
import { handleIncomingWhatsAppMessage } from "../services/whatsapp-bot.js";
const WEBHOOK_SECRET = process.env.OPENWA_WEBHOOK_SECRET ?? "";
/** In-memory idempotency (Aiven Free — no extra Postgres table). TTL 10 minutes. */
const processedKeys = new Map();
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
function pruneIdempotency() {
    const now = Date.now();
    for (const [key, expiresAt] of processedKeys) {
        if (expiresAt <= now)
            processedKeys.delete(key);
    }
}
function markProcessed(key) {
    pruneIdempotency();
    if (processedKeys.has(key))
        return false;
    processedKeys.set(key, Date.now() + IDEMPOTENCY_TTL_MS);
    return true;
}
function verifyOpenWASignature(rawBody, signature, secret) {
    if (!secret)
        return false;
    if (!signature)
        return false;
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (signatureBuffer.length !== expectedBuffer.length)
        return false;
    return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}
/**
 * POST /api/webhooks/whatsapp
 * Requires express.raw({ type: 'application/json' }) so HMAC matches raw bytes.
 */
export async function whatsappWebhookHandler(req, res) {
    try {
        const rawBody = Buffer.isBuffer(req.body)
            ? req.body
            : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}));
        if (WEBHOOK_SECRET) {
            const signature = req.header("X-OpenWA-Signature") ?? undefined;
            if (!verifyOpenWASignature(rawBody, signature, WEBHOOK_SECRET)) {
                res.status(401).send("Invalid signature");
                return;
            }
        }
        else {
            console.warn("[Webhook] OPENWA_WEBHOOK_SECRET not set — skipping signature verification");
        }
        const eventName = req.header("X-OpenWA-Event") ?? "";
        let payload;
        try {
            payload = JSON.parse(rawBody.toString("utf8"));
        }
        catch {
            res.status(400).send("Invalid JSON");
            return;
        }
        const event = payload.event || eventName;
        if (event && event !== "message.received") {
            res.status(200).send("OK");
            return;
        }
        const idempotencyKey = req.header("X-OpenWA-Idempotency-Key") ||
            payload.idempotencyKey ||
            payload.data?.id ||
            payload.deliveryId;
        if (idempotencyKey && !markProcessed(idempotencyKey)) {
            res.status(200).send("OK");
            return;
        }
        const data = payload.data ?? {};
        if (data.fromMe || data.isGroup) {
            res.status(200).send("OK");
            return;
        }
        const bodyText = typeof data.body === "string" ? data.body.trim() : "";
        if (!bodyText) {
            res.status(200).send("OK");
            return;
        }
        if (data.type && data.type !== "chat" && data.type !== "text") {
            res.status(200).send("OK");
            return;
        }
        const chatId = data.chatId || data.from || "";
        if (!chatId) {
            res.status(200).send("OK");
            return;
        }
        const contact = data.contact && typeof data.contact === "object" ? data.contact : null;
        const identity = resolveWhatsAppSenderIdentity({
            from: data.from,
            chatId: data.chatId,
            author: data.author,
            senderPhone: data.senderPhone,
            senderPn: data.senderPn,
            contactNumber: contact?.number ?? null,
        });
        console.log("[Webhook] inbound identity (OpenWA payload vs derived digits)", {
            event,
            messageId: data.id ?? null,
            raw: {
                from: data.from ?? null,
                chatId: data.chatId ?? null,
                author: data.author ?? null,
                senderPn: data.senderPn ?? null,
                senderPhone: data.senderPhone ?? null,
                isLidSender: data.isLidSender ?? null,
                contact: contact
                    ? {
                        id: contact.id ?? null,
                        number: contact.number ?? null,
                        name: contact.name ?? null,
                        pushName: contact.pushName ?? null,
                    }
                    : null,
                notifyName: data.notifyName ?? data.pushName ?? null,
                type: data.type ?? null,
                isGroup: data.isGroup ?? false,
                dataKeys: Object.keys(data),
            },
            derived: {
                chatIdDigits: chatIdToPhoneDigits(chatId),
                fromIsLid: isLidJid(data.from),
                matchPhoneDigits: identity.matchPhoneDigits,
                replyChatId: identity.replyChatId,
                identitySource: identity.source,
            },
            bodyPreview: bodyText.slice(0, 80) + (bodyText.length > 80 ? "…" : ""),
        });
        if (!identity.replyChatId) {
            console.warn("[Webhook] skipped — could not resolve reply chatId", { chatId, identity });
            res.status(200).send("OK");
            return;
        }
        // Acknowledge quickly; process async so OpenWA does not retry on slow LLM calls
        res.status(200).send("OK");
        void handleIncomingWhatsAppMessage({
            chatId: identity.rawChatId || chatId,
            body: bodyText,
            matchPhoneDigits: identity.matchPhoneDigits,
            replyChatId: identity.replyChatId,
            identitySource: identity.source,
        }).catch((err) => {
            console.error("[Webhook] handleIncomingWhatsAppMessage failed:", err);
        });
    }
    catch (error) {
        console.error("[Webhook] whatsapp handler error:", error);
        if (!res.headersSent) {
            res.status(500).send("Error");
        }
    }
}
