import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLocalChecks } from './verify-local.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const UI_CHECKS = Object.freeze([
  'booking-solo-flow-browser', 'booking-draft-recovery-ui', 'phone-unknown-result-ui',
  'admin-startup-data-browser', 'admin-refresh-schema-browser', 'admin-reservation-refresh-ui',
  'admin-editor-loading-ui', 'admin-note-ack-browser', 'admin-cancel-conflict-ui',
  'admin-customer-details-review-ui', 'admin-date-details-ui', 'admin-numbers-loading-ui',
  'admin-notification-race-browser', 'customer-pagination-browser', 'admin-csv-safety-browser',
  'admin-publication-browser', 'admin-occupancy-intervals-ui', 'booking-email-queue-browser',
  'admin-brief-history-ui', 'admin-daily-usability', 'admin-savebar-focus', 'mypage-lookup-sync'
].map(name => `test/${name}.mjs`));

export async function verifyUI({ root = ROOT, output = process.stdout } = {}) {
  return verifyLocalChecks({ root, checks: UI_CHECKS, output, serial: true });
}

const invoked = process.argv[1] ? await realpath(process.argv[1]).catch(() => '') : '';
if (fileURLToPath(import.meta.url) === invoked) {
  try {
    if (process.argv.length !== 2) throw new Error('使い方: node --env-file=.env tools/verify-ui.mjs');
    const result = await verifyUI();
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
