export {
  type NotificationChannelId,
  type NotificationChannel,
  type Notification,
  type RetryOptions,
  type DeliveryRecorder,
  type ChannelOrderResolver,
  type OptoutChecker,
  DEFAULT_CHANNEL_ORDER,
  DEFAULT_RETRY,
} from './types.js';
export { NotificationDispatcher, type NotificationDispatcherDeps, staticChannelOrder } from './dispatcher.js';
export { dashboardBannerChannel } from './channels/dashboard-banner-channel.js';
export {
  buildWhatsAppChannel,
  RecipientOptedOutError,
  TEMPLATES as WHATSAPP_TEMPLATES,
  type WhatsAppTemplateName,
  type WhatsAppMessageContent,
  type WhatsAppConfig,
} from './channels/whatsapp-channel.js';
export { buildSlackChannel, type SlackMessageContent, type SlackConfig, type SlackBlock } from './channels/slack-channel.js';
export {
  buildEmailChannel,
  checkDomainVerification,
  EmailRecipientOptedOutError,
  type EmailMessageContent,
  type EmailConfig,
  type DomainVerificationResult,
  type DomainVerificationStatus,
} from './channels/email-channel.js';
