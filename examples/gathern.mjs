// Example: capture all api.gathern.co traffic while a human navigates the
// Gathern business portal. Run with:
//
//   node examples/gathern.mjs
//
// Make sure you've built first: `npm run build`.

import { launchChrome, attach, captureContext, writeHar } from '../dist/index.js';

const chrome = await launchChrome({
    startUrl: 'https://business.gathern.co/app/dashboard',
    // Reuse this dir across runs to keep your Gathern session/cookies.
    userDataDir: process.env.HOME + '/.gathern-capture-profile',
});

console.log(`Chrome started, profile: ${chrome.userDataDir}`);

const { browser, defaultContext } = await attach({ cdpUrl: chrome.cdpUrl });

const capture = captureContext(defaultContext, {
    filter: 'api.gathern.co',
    onEvent: (event) => {
        if (event.direction === 'response') {
            console.log(`${event.status} ${event.method} ${event.url}`);
        }
    },
});

console.log('Capturing. Log in & navigate Gathern. Press Ctrl-C to stop.\n');

process.on('SIGINT', async () => {
    await capture.stop();
    await writeHar(capture.events, './gathern.har');
    console.log(`\nSaved gathern.har with ${capture.events.length} events.`);
    await browser.close().catch(() => {});
    process.exit(0);
});

// Park forever.
await new Promise(() => {});
