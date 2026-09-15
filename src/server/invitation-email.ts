/**
 * @fileoverview Invitation email sent through Resend
 */

import { Resend } from "resend";
import type { EmailSender, Logger } from "../contracts.js";

export interface InvitationEmailConfig {
  /** The product named in the email, e.g. "ShapeShyft". */
  productName: string;
  /** Without one, sending is skipped with a warning. */
  resendApiKey?: string;
  senderEmail?: string;
  /** Default: `productName`. */
  senderName?: string;
  /** The web app's origin, for the dashboard link. */
  appUrl?: string;
  logger?: Logger;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape text for HTML. Entity names are chosen by users and land in an email
 * sent to someone else, so they must not be able to inject markup or links.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]!);
}

/** Subject and HTML body of an invitation, exported for tests. */
export function renderInvitationEmail(params: {
  productName: string;
  entityName: string;
  appUrl: string;
}): { subject: string; html: string } {
  const product = escapeHtml(params.productName);
  const entity = escapeHtml(params.entityName);
  const appUrl = escapeHtml(params.appUrl);
  const dashboardUrl = `${appUrl}/en/dashboard?redirect=/invitations`;

  return {
    // Plain text, since mail clients do not render markup in subjects; line
    // breaks are removed so a name cannot spill into other headers.
    subject:
      `You've been invited to join ${params.entityName} on ${params.productName}`.replace(
        /[\r\n]+/g,
        " "
      ),
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #111; margin-bottom: 16px;">You're invited!</h2>
        <p style="color: #333; font-size: 16px; line-height: 1.5;">
          You've been invited to join <strong>${entity}</strong> on ${product}.
        </p>
        <p style="color: #333; font-size: 16px; line-height: 1.5;">
          Sign in to your ${product} account to accept the invitation:
        </p>
        <a href="${dashboardUrl}"
           style="display: inline-block; background: #111; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-size: 16px; margin: 16px 0;">
          Go to Dashboard
        </a>
        <p style="color: #666; font-size: 14px; line-height: 1.5; margin-top: 24px;">
          This invitation will expire in 14 days. If you don't have an account yet, sign up at
          <a href="${appUrl}" style="color: #111;">${appUrl}</a> using this email address
          and the invitation will be automatically accepted.
        </p>
      </div>
    `,
  };
}

export function createInvitationEmailSender(
  config: InvitationEmailConfig
): EmailSender {
  const logger = config.logger ?? console;
  const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;
  if (!resend) {
    logger.warn("RESEND_API_KEY not set — invitation emails will not be sent");
  }

  return {
    async sendInvitationEmail({ recipientEmail, entityName }) {
      if (!resend) {
        logger.warn("Skipping invitation email — Resend not configured");
        return;
      }
      const { subject, html } = renderInvitationEmail({
        productName: config.productName,
        entityName,
        appUrl: config.appUrl ?? "http://localhost:5173",
      });
      const { error } = await resend.emails.send({
        from: `${config.senderName ?? config.productName} <${config.senderEmail ?? "onboarding@resend.dev"}>`,
        to: recipientEmail,
        subject,
        html,
      });
      if (error) {
        throw new Error(`Resend error: ${error.message}`);
      }
    },
  };
}
