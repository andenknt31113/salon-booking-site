import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLocalChecks } from './verify-local.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BOOKING_CHECKS = Object.freeze([
  'final-backend-boundaries', 'booking-change-recovery', 'booking-ledger-schema', 'booking-ledger-initialization', 'booking-backup-safety', 'booking-public-errors',
  'booking-overlap-reads', 'booking-availability-dates', 'booking-reserve-reads', 'booking-reserve-ack',
  'booking-cancel-ack', 'booking-cancel-conflict', 'booking-identity-privacy', 'booking-target-consistency', 'admin-auth-boundary', 'admin-logout-deadline',
  'admin-legacy-preflight', 'admin-setup-guidance', 'phone-request-identity', 'phone-booking-ack', 'phone-result-receipt',
  'booking-write-settings', 'booking-operation-settings', 'admin-note-ack',
  'admin-upload-lock', 'closed-save-validation', 'admin-save-scope', 'admin-save-ack', 'request-lock', 'reminder-recovery',
  'admin-note-conflict', 'admin-note-ack-ui', 'booking-lookup-reads', 'reservation-lookup', 'request-dispatch',
  'booking-write-response', 'booking-input-limits', 'booking-clock-boundary', 'admin-change-receipt',
  'site-publication-backend', 'site-publication', 'site-publication-flow', 'publication-cache',
  'publication-gate', 'publication-write-safety', 'publish-menu-redirect',
  'reminders', 'phone-retry', 'admin-save-guard', 'customer-phone-guard', 'mock-change',
  'admin-conditional-refresh-backend', 'admin-conditional-refresh', 'booking-calendar-refresh',
  'public-read-client', 'public-read-transport', 'availability-response', 'catalog-response'
].map(name => `test/${name}.mjs`));

export async function verifyBooking({ root = ROOT, output = process.stdout } = {}) {
  return verifyLocalChecks({ root, checks: BOOKING_CHECKS, output });
}

const invoked = process.argv[1] ? await realpath(process.argv[1]).catch(() => '') : '';
if (fileURLToPath(import.meta.url) === invoked) {
  try {
    if (process.argv.length !== 2) throw new Error('使い方: node tools/verify-booking.mjs');
    const result = await verifyBooking();
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
