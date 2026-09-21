import { describe, expect, it } from 'vitest';
import { greeting, cvReceived, completed, needsReview, adminOnline, adminOffline, adminFailed, adminReview, adminModelChanged } from '../templates.js';

describe('business templates', () => {
  it('offers CV guidance without asking for fields already in the CV', () => {
    expect(greeting()).toContain('Please send your CV');
    expect(cvReceived()).toContain('CV received');
    expect(completed()).toBe('Your application has been received successfully. Thank you.');
    for (const message of [greeting(), cvReceived(), completed(), needsReview(['nic'])]) expect(message).not.toMatch(/OpenRouter|Gemini|OneDrive|Google Sheets|pipeline|VALIDATING|DOWNLOADING/i);
  });
  it('asks only for missing fields once, and asks nothing for an empty list', () => {
    expect(needsReview(['nic', 'address', 'nic'])).toBe('Please provide the following missing details: NIC, address. Thank you.');
    expect(needsReview([])).not.toMatch(/provide|send|\?/i);
  });
  it('formats safe server details and optional host fingerprint', () => {
    const message = adminOnline({ deviceName: 'CV-AUTO-01', ip: '192.168.1.25', sshHint: 'ssh admin@192.168.1.25', dashboardUrl: 'http://192.168.1.25:3000', fingerprint: 'SHA256:abc' });
    for (const value of ['ONLINE', 'CV-AUTO-01', '192.168.1.25', 'ssh admin@192.168.1.25', 'http://192.168.1.25:3000', 'SHA256:abc']) expect(message).toContain(value);
    expect(adminOffline('CV-AUTO-01')).toContain('OFFLINE');
    expect(adminReview('APP-1', ['name'])).toContain('name');
    expect(adminModelChanged('provider/old', 'provider/new')).toContain('provider/new');
  });
  it('renders a strict-format SSH tunnel line and rejects anything else', () => {
    const ok = adminOnline({ deviceName: 'd', ip: '1.2.3.4', sshHint: 'ssh admin@1.2.3.4', dashboardUrl: 'http://127.0.0.1:3001/admin/dashboard', sshTunnel: 'ssh -L 3001:127.0.0.1:3001 admin@1.2.3.4' });
    expect(ok).toContain('Tunnel: ssh -L 3001:127.0.0.1:3001 admin@1.2.3.4');
    for (const bad of ['ssh -L 3001:127.0.0.1:3001 admin@1.2.3.4; rm -rf /', 'scp file admin@1.2.3.4:/tmp', 'ssh -X admin@1.2.3.4']) {
      const message = adminOnline({ deviceName: 'd', ip: '1.2.3.4', sshHint: 'ssh admin@1.2.3.4', dashboardUrl: 'http://127.0.0.1:3001', sshTunnel: bad });
      expect(message).not.toContain('Tunnel:');
      expect(message).not.toContain('rm -rf');
    }
  });
  it('never relays raw exception text or URL credentials', () => {
    const message = adminFailed('APP-1', new Error('Bearer super-private-token; client_secret=other-secret'));
    expect(message).toContain('APP-1'); expect(message).not.toMatch(/super-private-token|other-secret/);
    expect(adminOnline({ deviceName: 'device', ip: '127.0.0.1', sshHint: 'ssh admin@127.0.0.1', dashboardUrl: 'https://user:password@example.com/?token=secret#secret' })).toContain('https://example.com/');
  });
});
