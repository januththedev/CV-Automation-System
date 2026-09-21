/**
 * API runtime composition (appliance entry). Import-safe: no I/O, connections,
 * config loads or signal handlers run at import time; execution starts only
 * when this module is the process entry point.
 */

import { pathToFileURL } from 'node:url';
import { startApiRuntime } from './server.js';

export { createApiServer, startApiRuntime } from './server.js';
export type { ApiRuntime, ApiRuntimeOptions, ApiServerOptions } from './server.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startApiRuntime().catch(() => {
    process.exitCode = 1;
  });
}
