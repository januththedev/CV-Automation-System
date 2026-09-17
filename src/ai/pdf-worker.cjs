'use strict';
// Static PDF parsing worker: never loads pdf-parse/index.js (it self-tests on import).
// Runs isolated with resource limits so a stuck parser can be terminated hard.
const { parentPort, workerData } = require('node:worker_threads');

(async () => {
  try {
    const parse = require('pdf-parse/lib/pdf-parse.js');
    let blankPages = 0;
    const parsed = await parse(Buffer.from(workerData.bytes), {
      max: 101,
      pagerender: async (page) => {
        const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
        const text = content.items.map(item => item.str || '').join(' ');
        if (!text.trim()) blankPages++;
        return text;
      },
    });
    if (parsed.text.length > 100000 || parsed.numpages > 100) {
      parentPort.postMessage({ tooLarge: true });
    } else parentPort.postMessage({ text: parsed.text, pages: parsed.numpages, blankPages });
  } catch { parentPort.postMessage({ failed: true }); }
})();
