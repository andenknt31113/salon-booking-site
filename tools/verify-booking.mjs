import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLocalChecks } from './verify-local.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BOOKING_CHECKS = Object.freeze([
  'final-backend-boundaries', 'booking-change-recovery', 'booking-ledger-schema', 'booking-backup-safety', 'booking-public-errors',
  'booking-overlap-reads', 'booking-availability-dates', 'booking-reserve-reads', 'booking-reserve-ack',
  'booking-cancel-ack', 'booking-cancel-conflict', 'booking-identity-privacy', 'admin-auth-boundary',
  'admin-legacy-preflight', 'phone-request-identity', 'phone-booking-ack',
  'booking-write-settings', 'booking-operation-settings', 'admin-note-ack',
  'admin-upload-lock', 'closed-save-validation', 'request-lock', 'reminder-recovery',
  'admin-note-conflict', 'admin-note-ack-ui', 'booking-lookup-reads', 'reservation-lookup', 'request-dispatch'
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
