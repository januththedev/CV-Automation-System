import type { ExtractableField } from '../../contracts.js';

const labels: Record<ExtractableField, string> = { name: 'full name', nic: 'NIC', address: 'address', cv_phone_number: 'contact phone number', profession: 'profession' };
function missingLabels(missing: readonly ExtractableField[]): string[] {
  return [...new Set(missing)].filter(field => Object.hasOwn(labels, field)).map(field => labels[field]);
}

export function greeting(): string { return 'Thank you for your interest. Please send your CV and any additional details you would like us to consider.'; }
export function cvReceived(): string { return 'CV received. We are processing your application. Thank you.'; }
export function completed(): string { return 'Your application has been received successfully. Thank you.'; }
export function needsReview(missing: readonly ExtractableField[]): string {
  const fields = missingLabels(missing);
  return fields.length ? `Please provide the following missing details: ${fields.join(', ')}. Thank you.` : 'Thank you. We have your application details.';
}

export interface AdminOnlineDetails {
  deviceName: string;
  ip: string;
  sshHint: string;
  dashboardUrl: string;
  fingerprint?: string;
  sshTunnel?: string;
}

// These templates accept only display fields, never configuration objects or credentials.
// Reject credential-like values rather than forwarding arbitrary multiline content.
function safe(value: string): string {
  return /[\r\n]|bearer\s|(?:secret|token|password|api.?key|private.?key)\s*[:=]|-----BEGIN/i.test(value) ? '[redacted]' : value.slice(0, 200);
}
function dashboard(value: string): string {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return 'Not configured';
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return safe(url.href);
  } catch { return 'Not configured'; }
}
export function adminOnline(details: AdminOnlineDetails): string {
  const ssh = /^ssh (?:-p \d{1,5} )?[\w.-]+@[\w.:[\]-]+$/.test(details.sshHint) ? details.sshHint : 'Use your configured SSH account';
  const tunnel = details.sshTunnel && /^ssh -L \d{1,5}:127\.0\.0\.1:\d{1,5} [\w.-]+@[\w.:[\]-]+$/.test(details.sshTunnel)
    ? `\nTunnel: ${details.sshTunnel}` : '';
  const fingerprint = details.fingerprint && /^SHA256:[A-Za-z0-9+/=]+$/.test(details.fingerprint) ? `\nSSH Fingerprint: ${details.fingerprint}` : '';
  return `CV AUTOMATION ONLINE\nDevice: ${safe(details.deviceName)}\nIP: ${safe(details.ip)}\nSSH: ${ssh}${tunnel}\nDashboard: ${dashboard(details.dashboardUrl)}${fingerprint}\nStatus: ONLINE`;
}
export function adminOffline(deviceName = 'CV Automation'): string { return `CV AUTOMATION OFFLINE\nDevice: ${safe(deviceName)}\nStatus: OFFLINE`; }
export function adminFailed(appId: string, error: unknown): string {
  // Raw errors often embed authorization headers, signed URLs, CV data or credentials.
  // Only known non-secret categories may leave the device.
  const category = error === 'timeout' ? 'The operation timed out.' : error === 'authentication' ? 'Service authentication requires attention.' : 'Processing failed. Please check the application in the dashboard.';
  return `APPLICATION FAILED\nApplication: ${safe(appId)}\n${category}`;
}
export function adminReview(appId: string, missing: readonly ExtractableField[]): string {
  const fields = missingLabels(missing);
  return `APPLICATION REQUIRES REVIEW\nApplication: ${safe(appId)}\n${fields.length ? `Missing details: ${fields.join(', ')}` : 'Please review the application in the dashboard.'}`;
}
export function adminModelChanged(oldModel: string, newModel: string): string {
  return `AI MODEL CHANGED\nPrevious model: ${safe(oldModel)}\nCurrent model: ${safe(newModel)}`;
}
