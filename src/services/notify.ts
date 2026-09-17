import { hostname, networkInterfaces } from 'node:os';
import type { ExtractableField, WhatsAppConfig } from '../contracts.js';
import { loadConfig } from '../config.js';
import { WhatsAppClient } from '../integrations/whatsapp/client.js';
import { adminOnline, adminOffline, adminFailed, adminReview, adminModelChanged } from '../integrations/whatsapp/templates.js';

export type AdminEvent =
  | { type: 'online'; deviceName?: string; ip?: string; sshHint?: string; dashboardUrl?: string; fingerprint?: string }
  | { type: 'offline'; deviceName?: string }
  | { type: 'failed'; appId: string; error: unknown }
  | { type: 'review'; appId: string; missing: ExtractableField[] }
  | { type: 'model_changed'; oldModel: string; newModel: string };

export function formatAdminMessage(event: AdminEvent): string {
  switch (event.type) {
    case 'online': {
      const ip = event.ip ?? Object.values(networkInterfaces()).flat().find(address => address && !address.internal && address.family === 'IPv4')?.address ?? '127.0.0.1';
      return adminOnline({ deviceName: event.deviceName ?? hostname(), ip, sshHint: event.sshHint ?? `ssh <username>@${ip}`, dashboardUrl: event.dashboardUrl ?? `http://${ip}:3000`, fingerprint: event.fingerprint });
    }
    case 'offline': return adminOffline(event.deviceName ?? hostname());
    case 'failed': return adminFailed(event.appId, event.error);
    case 'review': return adminReview(event.appId, event.missing);
    case 'model_changed': return adminModelChanged(event.oldModel, event.newModel);
  }
}

/** Unconfigured notifications are a no-op. Delivery failures propagate for queue retry. */
export async function sendAdmin(event: AdminEvent, cfg?: WhatsAppConfig, adminNumber?: string): Promise<void> {
  const defaults = cfg === undefined || adminNumber === undefined ? loadConfig() : undefined;
  const whatsapp = cfg ?? defaults?.whatsapp;
  const number = adminNumber ?? defaults?.adminWhatsappNumber;
  if (!whatsapp?.accessToken?.trim() || !whatsapp.phoneNumberId?.trim() || !number?.trim()) return;
  const displayEvent = event.type === 'online' ? { ...event, deviceName: event.deviceName ?? defaults?.deviceName, dashboardUrl: event.dashboardUrl ?? defaults?.dashboardUrl ?? undefined } : event;
  // Do not let even an accidentally supplied configured credential leave in display fields.
  let message = formatAdminMessage(displayEvent);
  for (const secret of [whatsapp.accessToken, whatsapp.verifyToken, whatsapp.appSecret]) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  await new WhatsAppClient(whatsapp).sendText(number, message);
}
