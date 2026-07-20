import { pool } from "../config/db.js";
import {
  buildLeadCreatedMessage,
  normalizePhoneDigits,
  sendWhatsAppMessage,
  type LeadForNotification,
} from "./whatsapp.js";

export async function notifyAllUsersNewLead(
  lead: LeadForNotification & { assigned_to?: string | null },
  createdBy: string
): Promise<void> {
  console.log("[WhatsApp] notifyAllUsersNewLead start", { leadName: lead.name, createdBy });

  try {
    const creatorResult = await pool.query(
      "SELECT full_name FROM profiles WHERE id = $1",
      [createdBy]
    );
    const creatorName = creatorResult.rows[0]?.full_name ?? "Someone";

    let assigneeName: string | null = lead.assignee_name ?? null;
    if (!assigneeName && lead.assigned_to) {
      const assigneeResult = await pool.query(
        "SELECT full_name FROM profiles WHERE id = $1",
        [lead.assigned_to]
      );
      assigneeName = assigneeResult.rows[0]?.full_name ?? null;
    }

    const message = buildLeadCreatedMessage(
      { ...lead, assignee_name: assigneeName },
      creatorName
    );

    const phonesResult = await pool.query(
      `SELECT phone FROM profiles
       WHERE phone IS NOT NULL AND trim(phone) <> ''`
    );

    const seen = new Set<string>();
    const phones: string[] = [];
    for (const row of phonesResult.rows as { phone: string }[]) {
      const digits = normalizePhoneDigits(row.phone);
      if (!digits || seen.has(digits)) continue;
      seen.add(digits);
      phones.push(row.phone);
    }

    console.log("[WhatsApp] Broadcasting new lead", {
      leadName: lead.name,
      recipientCount: phones.length,
    });

    await Promise.all(
      phones.map((phone) =>
        sendWhatsAppMessage(phone, message).catch((err) => {
          console.error("[WhatsApp] Fail to notify user of new lead:", { phone, err });
        })
      )
    );

    console.log("[WhatsApp] notifyAllUsersNewLead finished", {
      leadName: lead.name,
      recipientCount: phones.length,
    });
  } catch (error) {
    console.error("[WhatsApp] notifyAllUsersNewLead error:", error);
  }
}
