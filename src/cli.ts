#!/usr/bin/env node
import { Command } from 'commander';
import { attach } from './attach.js';
import { captureContext, type CapturedEvent } from './capture.js';
import { launchChrome } from './chrome.js';
import { writeHar } from './har.js';

const program = new Command();

program
    .name('playwright-attach-chrome')
    .description(
        'Launch (or attach to) a Chrome window, then capture & export the network traffic of whatever you do inside it.',
    )
    .version('0.1.0');

program
    .command('capture')
    .description('Launch Chrome, attach Playwright, capture network as you browse.')
    .option('-u, --url <url>', 'URL to open in the first tab')
    .option(
        '-f, --filter <pattern>',
        'Only capture URLs containing this substring (or matching this /regex/)',
    )
    .option('-o, --har <path>', 'Write a HAR file on exit')
    .option('-n, --ndjson <path>', 'Stream events as NDJSON to this file')
    .option('-p, --port <number>', 'CDP port (default 9222)', '9222')
    .option('--chrome-path <path>', 'Path to Chrome binary (auto-detected if omitted)')
    .option(
        '--user-data-dir <path>',
        'Chrome profile directory. Reuse the same path across runs to keep your session/cookies.',
    )
    .option('--no-bodies', 'Skip request/response bodies (saves memory on large pages)')
    .option('--max-body-bytes <number>', 'Truncate bodies larger than this many bytes', '1000000')
    .option('--quiet', 'Suppress the live log')
    .action(async (opts) => {
        const filter = parseFilter(opts.filter);
        // Launch with about:blank so we can attach BEFORE navigation. Otherwise
        // the page loads (and finishes) before Playwright is listening, and the
        // initial request burst is lost.
        const chrome = await launchChrome({
            chromePath: opts.chromePath,
            port: Number(opts.port),
            userDataDir: opts.userDataDir,
            startUrl: 'about:blank',
        });

        log(`Chrome started.`);
        log(`  CDP:           ${chrome.cdpUrl}`);
        log(`  Profile dir:   ${chrome.userDataDir}`);
        if (opts.userDataDir) {
            log(`  (Profile is persistent — reuse --user-data-dir on next run to keep your login.)`);
        } else {
            log(`  (Profile is a temp dir — session will be lost when Chrome closes.)`);
        }

        const { browser, defaultContext } = await attach({ cdpUrl: chrome.cdpUrl });

        log(`Playwright attached. Capturing…`);
        if (filter) {
            log(`  Filter: ${opts.filter}`);
        }
        if (opts.ndjson) {
            log(`  Streaming → ${opts.ndjson}`);
        }
        if (opts.har) {
            log(`  HAR (on exit) → ${opts.har}`);
        }
        log(`\n  Press Ctrl-C to stop and flush.\n`);

        const capture = captureContext(defaultContext, {
            filter,
            includeRequestBody: opts.bodies !== false,
            includeResponseBody: opts.bodies !== false,
            maxBodyBytes: Number(opts.maxBodyBytes),
            outputNdjson: opts.ndjson,
            onEvent: opts.quiet ? undefined : printEvent,
        });

        // Now that capture is wired, navigate to the requested URL so the
        // initial request burst is recorded.
        if (opts.url) {
            const firstPage = defaultContext.pages()[0] ?? (await defaultContext.newPage());
            firstPage.goto(opts.url).catch((err) => {
                log(`Navigation to ${opts.url} failed: ${err.message}`);
            });
        }

        const cleanup = async (): Promise<void> => {
            log('\nStopping capture…');
            await capture.stop();
            if (opts.har) {
                await writeHar(capture.events, opts.har);
                log(`HAR written: ${opts.har} (${capture.events.length} events)`);
            }
            await browser.close().catch(() => {});
            // Leave the Chrome process running — the user owns it. They can quit it manually.
            process.exit(0);
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

        // Park forever; capture happens through event listeners.
        await new Promise(() => {});
    });

program
    .command('attach')
    .description('Attach to an already-running Chrome (launched separately with --remote-debugging-port).')
    .requiredOption('-p, --port <number>', 'CDP port the existing Chrome is listening on')
    .option('-f, --filter <pattern>', 'URL substring or /regex/')
    .option('-o, --har <path>', 'Write a HAR file on exit')
    .option('-n, --ndjson <path>', 'Stream events as NDJSON to this file')
    .option('--no-bodies', 'Skip request/response bodies')
    .option('--max-body-bytes <number>', 'Truncate bodies larger than this many bytes', '1000000')
    .option('--quiet', 'Suppress the live log')
    .action(async (opts) => {
        const filter = parseFilter(opts.filter);
        const cdpUrl = `http://localhost:${opts.port}`;
        log(`Attaching to ${cdpUrl}…`);

        const { browser, defaultContext } = await attach({ cdpUrl });
        log(`Attached. Capturing…`);
        if (filter) log(`  Filter: ${opts.filter}`);
        if (opts.ndjson) log(`  Streaming → ${opts.ndjson}`);
        if (opts.har) log(`  HAR (on exit) → ${opts.har}`);
        log(`\n  Press Ctrl-C to stop and flush.\n`);

        const capture = captureContext(defaultContext, {
            filter,
            includeRequestBody: opts.bodies !== false,
            includeResponseBody: opts.bodies !== false,
            maxBodyBytes: Number(opts.maxBodyBytes),
            outputNdjson: opts.ndjson,
            onEvent: opts.quiet ? undefined : printEvent,
        });

        const cleanup = async (): Promise<void> => {
            log('\nStopping capture…');
            await capture.stop();
            if (opts.har) {
                await writeHar(capture.events, opts.har);
                log(`HAR written: ${opts.har} (${capture.events.length} events)`);
            }
            await browser.close().catch(() => {});
            process.exit(0);
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

        await new Promise(() => {});
    });

program
    .command('mcp')
    .description(
        'Run as a Model Context Protocol server (stdio). Lets an AI assistant drive the launch + capture + export flow over MCP tool calls.',
    )
    .action(async () => {
        const { startMcpServer } = await import('./mcp.js');
        await startMcpServer();
    });

program.parseAsync(process.argv).catch((err) => {
    console.error(err.message);
    process.exit(1);
});

function parseFilter(input?: string): string | RegExp | undefined {
    if (!input) return undefined;
    const re = input.match(/^\/(.*)\/([gimsuy]*)$/);
    if (re && re[1] !== undefined) {
        return new RegExp(re[1], re[2]);
    }
    return input;
}

function printEvent(event: CapturedEvent): void {
    if (event.direction === 'request') {
        log(`→ ${event.method.padEnd(6)} ${event.url}`);
    } else {
        const status = event.status ?? 0;
        log(`← ${String(status).padEnd(6)} ${event.url}`);
    }
}

function log(line: string): void {
    process.stdout.write(line + '\n');
}
