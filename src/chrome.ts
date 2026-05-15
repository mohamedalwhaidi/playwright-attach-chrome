import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const MAC_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const LINUX_CANDIDATES = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
    '/snap/bin/chromium',
];

const WIN_CANDIDATES = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/**
 * Locate a Chrome / Chromium-family binary on disk. Returns the first match
 * across the candidate list for the current platform, or throws.
 */
export function findChromeBinary(): string {
    const candidates =
        process.platform === 'darwin'
            ? MAC_CANDIDATES
            : process.platform === 'win32'
              ? WIN_CANDIDATES
              : LINUX_CANDIDATES;

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error(
        `Could not find Chrome on ${process.platform}. Looked in:\n  ${candidates.join('\n  ')}\n` +
            `Pass --chrome-path to specify the binary explicitly.`,
    );
}

export interface LaunchChromeOptions {
    /** Path to Chrome binary. Auto-detected if omitted. */
    chromePath?: string;
    /** CDP debugging port. Default 9222. */
    port?: number;
    /** User data dir. A temp dir is created if omitted (fresh profile each run). */
    userDataDir?: string;
    /** URL to open in the first tab. */
    startUrl?: string;
    /** Extra flags to pass to Chrome. */
    extraArgs?: string[];
}

export interface LaunchedChrome {
    process: ChildProcess;
    port: number;
    userDataDir: string;
    cdpUrl: string;
}

/**
 * Launch Chrome with remote debugging enabled and a dedicated profile dir.
 * Returns once the CDP endpoint responds, so the caller can immediately
 * connect via `chromium.connectOverCDP()`.
 */
export async function launchChrome(opts: LaunchChromeOptions = {}): Promise<LaunchedChrome> {
    const binary = opts.chromePath ?? findChromeBinary();
    const port = opts.port ?? 9222;
    const userDataDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), 'pac-chrome-'));

    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        ...(opts.extraArgs ?? []),
    ];

    if (opts.startUrl) {
        args.push(opts.startUrl);
    }

    const child = spawn(binary, args, { stdio: 'ignore', detached: false });

    child.on('error', (err) => {
        console.error('[chrome] failed to start:', err.message);
    });

    const cdpUrl = `http://localhost:${port}`;
    await waitForCdp(cdpUrl);

    return { process: child, port, userDataDir, cdpUrl };
}

async function waitForCdp(cdpUrl: string, timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`${cdpUrl}/json/version`);
            if (res.ok) {
                return;
            }
        } catch {
            // Chrome not up yet, keep polling.
        }
        await delay(150);
    }
    throw new Error(`Chrome CDP did not respond at ${cdpUrl} within ${timeoutMs}ms.`);
}
