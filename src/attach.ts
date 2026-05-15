import { chromium, type Browser, type BrowserContext } from 'playwright-core';

export interface AttachOptions {
    /** CDP endpoint, e.g. `http://localhost:9222`. */
    cdpUrl: string;
    /** Slow-mo, ms between actions. Useful for demos. */
    slowMo?: number;
}

export interface AttachedSession {
    browser: Browser;
    /** All contexts (one per Chrome profile). Usually length 1. */
    contexts: BrowserContext[];
    /** Default context — the existing profile's context. */
    defaultContext: BrowserContext;
}

/**
 * Connect to a running Chrome instance via CDP. The Chrome must have been
 * started with `--remote-debugging-port=<port>` and `--user-data-dir=<dir>`.
 *
 * Returns immediately; the caller is responsible for closing the browser
 * (or leaving Chrome running and just disconnecting).
 */
export async function attach(opts: AttachOptions): Promise<AttachedSession> {
    const browser = await chromium.connectOverCDP(opts.cdpUrl, {
        slowMo: opts.slowMo,
    });

    const contexts = browser.contexts();
    const defaultContext = contexts[0];

    if (!defaultContext) {
        throw new Error(
            `Connected to ${opts.cdpUrl} but no browser context was returned. Is Chrome actually running?`,
        );
    }

    return { browser, contexts, defaultContext };
}
