import { resend, EMAIL_FROM } from './resend';
import { WelcomeEmail, WelcomeEmailProps } from './templates/welcome';
import { InvitationEmail, InvitationEmailProps } from './templates/invitation';
import { DeploymentNotificationEmail, DeploymentNotificationEmailProps } from './templates/deployment-notification';
import { PasswordResetEmail, PasswordResetEmailProps } from './templates/password-reset';
import { BillingAlertEmail, BillingAlertEmailProps } from './templates/billing-alert';
import { UsageWarningEmail, UsageWarningEmailProps } from './templates/usage-warning';
import { createElement, type ReactElement } from 'react';

export class EmailService {
  private static async sendEmail(options: {
    to: string | string[];
    subject: string;
    react: ReactElement;
  }) {
    if (!process.env.RESEND_API_KEY) {
      console.log('Sending email (Dev Mode):', {
        to: options.to,
        subject: options.subject,
      });
      return { id: 'dev_mode_email_id' };
    }

    try {
      const data = await resend.emails.send({
        from: EMAIL_FROM,
        to: options.to,
        subject: options.subject,
        react: options.react,
      });
      return data;
    } catch (error) {
      console.error('Failed to send email:', error);
      throw error;
    }
  }

  static async sendWelcome(params: { to: string } & WelcomeEmailProps) {
    return this.sendEmail({
      to: params.to,
      subject: 'Welcome to SyncBay!',
      react: createElement(WelcomeEmail, params),
    });
  }

  static async sendInvitation(params: { to: string } & InvitationEmailProps) {
    return this.sendEmail({
      to: params.to,
      subject: `You've been invited to join ${params.teamName} on SyncBay`,
      react: createElement(InvitationEmail, params),
    });
  }

  static async sendDeploymentNotification(params: { to: string | string[] } & DeploymentNotificationEmailProps) {
    const statusText = params.status === 'success' ? 'Successful' : 'Failed';
    return this.sendEmail({
      to: params.to,
      subject: `Deployment ${statusText}: ${params.projectName}`,
      react: createElement(DeploymentNotificationEmail, params),
    });
  }

  static async sendPasswordReset(params: { to: string } & PasswordResetEmailProps) {
    return this.sendEmail({
      to: params.to,
      subject: 'Reset your SyncBay password',
      react: createElement(PasswordResetEmail, params),
    });
  }

  static async sendBillingAlert(params: { to: string | string[] } & BillingAlertEmailProps) {
    return this.sendEmail({
      to: params.to,
      subject: 'SyncBay Billing Alert',
      react: createElement(BillingAlertEmail, params),
    });
  }

  static async sendUsageWarning(params: { to: string | string[] } & UsageWarningEmailProps) {
    return this.sendEmail({
      to: params.to,
      subject: `Usage Warning: ${params.percentage}% reached on SyncBay`,
      react: createElement(UsageWarningEmail, params),
    });
  }
}
