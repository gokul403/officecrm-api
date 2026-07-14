import dotenv from "dotenv";
dotenv.config();
const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
const apiKey = process.env.BREVO_API_KEY;
const senderEmail = process.env.BREVO_SENDER_EMAIL || "admin@demo.com";
const senderName = process.env.BREVO_SENDER_NAME || "OfficeFlow CRM";
export async function sendTransactionalEmail(to, subject, htmlContent) {
    if (!to || to.length === 0) {
        console.log("[Email Service] No recipients specified. Skipping.");
        return;
    }
    if (!apiKey || apiKey === "PLACEHOLDER") {
        console.log(`[Email Service Mock] Sending email to ${to.map(t => t.email).join(", ")}`);
        console.log(`[Email Service Mock] Subject: ${subject}`);
        console.log(`[Email Service Mock] Content snippet: ${htmlContent.substring(0, 200).replace(/\s+/g, " ")}...`);
        return;
    }
    try {
        const response = await fetch(BREVO_API_URL, {
            method: "POST",
            headers: {
                "accept": "application/json",
                "api-key": apiKey,
                "content-type": "application/json"
            },
            body: JSON.stringify({
                sender: { name: senderName, email: senderEmail },
                to: to.map(t => ({ email: t.email, name: t.name || t.email })),
                subject: subject,
                htmlContent: htmlContent
            })
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Email Service] Failed to send email via Brevo: ${response.status} - ${errorText}`);
            throw new Error(`Brevo API returned error: ${response.status}`);
        }
        const data = await response.json();
        console.log(`[Email Service] Email sent successfully via Brevo:`, data);
    }
    catch (error) {
        console.error("[Email Service] Error sending transactional email:", error);
    }
}
// Helper: Task Assigned Email Template
export async function notifyTaskAssignment(task, assignees) {
    const formattedDueDate = task.due_date
        ? new Date(task.due_date).toLocaleDateString(undefined, { dateStyle: "medium" })
        : "No due date";
    const subject = `[New Assignment] Task: ${task.title}`;
    const htmlContent = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #f8fafc;">
      <div style="background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); padding: 20px; border-radius: 8px 8px 0 0; text-align: center; color: white;">
        <h1 style="margin: 0; font-size: 22px;">New Task Assigned</h1>
        <p style="margin: 5px 0 0 0; font-size: 14px; opacity: 0.9;">OfficeFlow Workspace Management</p>
      </div>
      <div style="padding: 20px; background-color: white; border-radius: 0 0 8px 8px;">
        <h2 style="margin-top: 0; color: #1e293b; font-size: 18px;">${task.title}</h2>
        <p style="color: #64748b; font-size: 14px; line-height: 1.5;">${task.description || "No description provided."}</p>
        
        <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
          <tr>
            <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-weight: 600; color: #475569; width: 120px;">Priority:</td>
            <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; color: #1e293b; text-transform: capitalize;">${task.priority}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-weight: 600; color: #475569;">Due Date:</td>
            <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; color: #1e293b;">${formattedDueDate}</td>
          </tr>
        </table>

        <div style="margin-top: 30px; text-align: center;">
          <a href="http://localhost:3000/tasks" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block; box-shadow: 0 4px 6px -1px rgba(37, 99, 235, 0.2);">
            View Workspace Tasks
          </a>
        </div>
      </div>
      <div style="text-align: center; margin-top: 20px; font-size: 11px; color: #94a3b8;">
        This is an automated notification from your OfficeFlow workspace.
      </div>
    </div>
  `;
    const recipients = assignees.map(a => ({ name: a.full_name || undefined, email: a.email }));
    await sendTransactionalEmail(recipients, subject, htmlContent);
}
// Helper: Task Updated Email Template
export async function notifyTaskUpdate(task, assignees) {
    const formattedDueDate = task.due_date
        ? new Date(task.due_date).toLocaleDateString(undefined, { dateStyle: "medium" })
        : "No due date";
    const subject = `[Task Updated] ${task.title}`;
    const htmlContent = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #f8fafc;">
      <div style="background: linear-gradient(135deg, #4f46e5 0%, #4338ca 100%); padding: 20px; border-radius: 8px 8px 0 0; text-align: center; color: white;">
        <h1 style="margin: 0; font-size: 22px;">Task Details Updated</h1>
        <p style="margin: 5px 0 0 0; font-size: 14px; opacity: 0.9;">OfficeFlow Workspace Management</p>
      </div>
      <div style="padding: 20px; background-color: white; border-radius: 0 0 8px 8px;">
        <h2 style="margin-top: 0; color: #1e293b; font-size: 18px;">${task.title}</h2>
        <p style="color: #64748b; font-size: 14px; line-height: 1.5;">${task.description || "No description provided."}</p>
        
        <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
          <tr>
            <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-weight: 600; color: #475569; width: 120px;">Status:</td>
            <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; color: #1e293b; text-transform: capitalize;">${task.status.replace("_", " ")}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-weight: 600; color: #475569;">Priority:</td>
            <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; color: #1e293b; text-transform: capitalize;">${task.priority}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-weight: 600; color: #475569;">Due Date:</td>
            <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; color: #1e293b;">${formattedDueDate}</td>
          </tr>
        </table>

        <div style="margin-top: 30px; text-align: center;">
          <a href="http://localhost:3000/tasks" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block; box-shadow: 0 4px 6px -1px rgba(79, 70, 229, 0.2);">
            View Workspace Tasks
          </a>
        </div>
      </div>
      <div style="text-align: center; margin-top: 20px; font-size: 11px; color: #94a3b8;">
        This is an automated notification from your OfficeFlow workspace.
      </div>
    </div>
  `;
    const recipients = assignees.map(a => ({ name: a.full_name || undefined, email: a.email }));
    await sendTransactionalEmail(recipients, subject, htmlContent);
}
// Helper: Lead Created Email Template
export async function notifyLeadAssignment(lead, assignee) {
    const subject = `[New Lead Assigned] Contact: ${lead.name}`;
    const htmlContent = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #f8fafc;">
      <div style="background: linear-gradient(135deg, #059669 0%, #047857 100%); padding: 20px; border-radius: 8px 8px 0 0; text-align: center; color: white;">
        <h1 style="margin: 0; font-size: 22px;">New Lead Assigned</h1>
        <p style="margin: 5px 0 0 0; font-size: 14px; opacity: 0.9;">OfficeFlow CRM System</p>
      </div>
      <div style="padding: 20px; background-color: white; border-radius: 0 0 8px 8px;">
        <h2 style="margin-top: 0; color: #1e293b; font-size: 18px;">${lead.name}</h2>
        <p style="color: #64748b; font-size: 14px; line-height: 1.5;">${lead.notes || "No lead notes provided."}</p>
        
        <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
          <tr>
            <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-weight: 600; color: #475569; width: 120px;">Company:</td>
            <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; color: #1e293b;">${lead.company || "—"}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-weight: 600; color: #475569;">Source:</td>
            <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; color: #1e293b; text-transform: capitalize;">${lead.source || "—"}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; font-weight: 600; color: #475569;">Lead Status:</td>
            <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; color: #1e293b; text-transform: capitalize;">${lead.status}</td>
          </tr>
        </table>

        <div style="margin-top: 30px; text-align: center;">
          <a href="http://localhost:3000/leads" style="background-color: #059669; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block; box-shadow: 0 4px 6px -1px rgba(5, 150, 105, 0.2);">
            View CRM Leads
          </a>
        </div>
      </div>
      <div style="text-align: center; margin-top: 20px; font-size: 11px; color: #94a3b8;">
        This is an automated notification from your OfficeFlow CRM workspace.
      </div>
    </div>
  `;
    await sendTransactionalEmail([{ name: assignee.full_name || undefined, email: assignee.email }], subject, htmlContent);
}
