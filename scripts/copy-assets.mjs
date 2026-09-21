import { copyFile, mkdir, readdir } from 'node:fs/promises';

const target = new URL('../dist/src/ai/', import.meta.url);
await mkdir(target, { recursive: true });
await copyFile(new URL('../src/ai/pdf-worker.cjs', import.meta.url), new URL('pdf-worker.cjs', target));

// dist/api/admin-server.js serves the dashboard via the relative path
// ../dashboard/, so the static assets must exist at dist/dashboard/.
const dashboardSource = new URL('../dashboard/', import.meta.url);
const dashboardTarget = new URL('../dist/dashboard/', import.meta.url);
await mkdir(dashboardTarget, { recursive: true });
for (const entry of await readdir(dashboardSource, { withFileTypes: true })) {
  if (entry.isFile()) {
    await copyFile(new URL(entry.name, dashboardSource), new URL(entry.name, dashboardTarget));
  }
}
