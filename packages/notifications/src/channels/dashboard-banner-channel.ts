/**
 * The last channel in AC2's own default order, and the one P5-01 ships
 * a REAL implementation of (unlike WhatsApp/Slack/email, which need
 * P5-02/P5-07/P5-08's own external credentials) — every tenant has a
 * dashboard regardless of what messaging channels they've configured,
 * so this is the one link in the chain that must always be able to
 * deliver.
 *
 * `send` has no work of its own: the dispatcher's own `recordAttempt`
 * persists `content` to `notification_deliveries` on a successful send
 * (@sentinel/db's NotificationDeliveryRepository), and that row IS the
 * banner's data — a future dashboard surface reads
 * `notification_deliveries WHERE channel = 'dashboard_banner'` directly
 * rather than this channel writing a second, redundant copy of the same
 * content somewhere else.
 */
import type { NotificationChannel } from '../types.js';

export const dashboardBannerChannel: NotificationChannel = {
  id: 'dashboard_banner',
  async send(): Promise<void> {
    // Always succeeds — see doc comment above for why there is nothing
    // else to do here.
  },
};
