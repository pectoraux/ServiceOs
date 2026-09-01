/**
 * ServiceOS /notifications channels (WORK-015, module internal — exported
 * through the module's public interface).
 *
 * The notification delivery channels this authority supports: the
 * external communication capabilities (email, SMS, voice — the
 * /integrations capability classes of the same names). This is a
 * PROJECTION of the /integrations capability taxonomy (the class list is
 * /integrations' authority), not a second taxonomy: the notification
 * surface accepts exactly these channels, and the interactions authority
 * independently validates the capability class it receives. The
 * projection relationship is proven by test (NOTIFICATION_CHANNELS ⊆
 * CAPABILITY_CLASSES), never by a cross-module structural dependency.
 */
export const NOTIFICATION_CHANNELS = ['email', 'sms', 'voice'] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return typeof value === 'string' && (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}
