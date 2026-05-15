import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Browser, BrowserContext } from 'playwright-core';
import { z } from 'zod';
import { attach } from './attach.js';
import { captureContext, type CaptureHandle, type CapturedEvent } from './capture.js';
import { launchChrome, type LaunchedChrome } from './chrome.js';
import { writeHar } from './har.js';

interface Session {
    id: string;
    chrome: LaunchedChrome;
    browser: Browser;
    context: BrowserContext;
    capture: CaptureHandle;
    started: Date;
    url: string;
    filter?: string | RegExp;
}

const sessions = new Map<string, Session>();

function parseFilter(input?: string): string | RegExp | undefined {
    if (!input) return undefined;
    const re = input.match(/^\/(.*)\/([gimsuy]*)$/);
    if (re && re[1] !== undefined) {
        return new RegExp(re[1], re[2]);
    }
    return input;
}

function requireSession(id: string): Session {
    const s = sessions.get(id);
    if (!s) {
        throw new Error(`Unknown sessionId: ${id}. It may have been stopped, or Chrome was closed externally.`);
    }
    return s;
}

function truncate(s: string | null | undefined, max: number): string | null {
    if (s === null || s === undefined) return null;
    if (s.length <= max) return s;
    return s.slice(0, max) + `…[truncated ${s.length - max} of ${s.length} bytes]`;
}

function eventSummary(event: CapturedEvent, index: number): {
    index: number;
    ts: string;
    direction: string;
    method: string;
    status?: number;
    url: string;
    resourceType?: string;
} {
    return {
        index,
        ts: event.ts,
        direction: event.direction,
        method: event.method,
        status: event.status,
        url: event.url,
        resourceType: event.resourceType,
    };
}

export async function startMcpServer(): Promise<void> {
    const server = new McpServer({
        name: 'playwright-attach-chrome',
        version: '0.2.0',
    });

    server.tool(
        'start_capture',
        'Launch a Chrome window with CDP enabled, attach Playwright, and begin capturing network traffic. The Chrome window opens on the user’s screen — they log in manually and click around. Returns a sessionId you pass to peek_events / stop_capture.',
        {
            url: z
                .string()
                .url()
                .describe('URL to navigate to in the first tab after attach.'),
            filter: z
                .string()
                .optional()
                .describe(
                    'Only capture URLs containing this substring, or matching this /regex/ pattern (slash-delimited).',
                ),
            userDataDir: z
                .string()
                .optional()
                .describe(
                    'Persistent Chrome profile directory. Reuse the same path across sessions to keep the user’s login. Omit for a fresh temp profile each run.',
                ),
            port: z
                .number()
                .int()
                .min(1024)
                .max(65535)
                .optional()
                .describe('CDP port. Default 9222.'),
        },
        async ({ url, filter, userDataDir, port }) => {
            const parsedFilter = parseFilter(filter);
            const chrome = await launchChrome({
                startUrl: 'about:blank',
                userDataDir,
                port,
            });
            const { browser, defaultContext } = await attach({ cdpUrl: chrome.cdpUrl });
            const capture = captureContext(defaultContext, {
                filter: parsedFilter,
                maxBodyBytes: 1_000_000,
            });

            const firstPage = defaultContext.pages()[0] ?? (await defaultContext.newPage());
            firstPage.goto(url).catch(() => {
                // Navigation errors are non-fatal; user can retry via the `navigate` tool.
            });

            const id = randomUUID();
            sessions.set(id, {
                id,
                chrome,
                browser,
                context: defaultContext,
                capture,
                started: new Date(),
                url,
                filter: parsedFilter,
            });

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                sessionId: id,
                                cdpUrl: chrome.cdpUrl,
                                profileDir: chrome.userDataDir,
                                profilePersistent: Boolean(userDataDir),
                                url,
                                filter: filter ?? null,
                                hint: 'Chrome window is open. Tell the user to log in / interact, then call peek_events to see what was captured. Call stop_capture when done.',
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.tool(
        'peek_events',
        'Return a summary list of captured events for the session, newest first (without stopping the capture). Use get_event for full headers/body of a specific entry.',
        {
            sessionId: z.string(),
            limit: z
                .number()
                .int()
                .min(1)
                .max(500)
                .default(50)
                .describe('Max events to return. Default 50.'),
            filter: z
                .string()
                .optional()
                .describe(
                    'Additional substring/regex filter on top of the session-wide filter.',
                ),
            direction: z
                .enum(['request', 'response', 'both'])
                .default('both')
                .describe('Filter by direction.'),
        },
        async ({ sessionId, limit, filter, direction }) => {
            const session = requireSession(sessionId);
            const extraFilter = parseFilter(filter);
            const all = session.capture.events;

            const filtered = all.filter((event) => {
                if (direction !== 'both' && event.direction !== direction) return false;
                if (!extraFilter) return true;
                return typeof extraFilter === 'string'
                    ? event.url.includes(extraFilter)
                    : extraFilter.test(event.url);
            });

            const recent = filtered.slice(-limit).reverse();
            const indexInAll = new Map<CapturedEvent, number>();
            all.forEach((e, i) => indexInAll.set(e, i));

            const summaries = recent.map((e) => eventSummary(e, indexInAll.get(e) ?? -1));

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                sessionId,
                                totalEvents: all.length,
                                returned: summaries.length,
                                events: summaries,
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.tool(
        'get_event',
        'Return full details of one captured event — headers, body, status. Body is truncated to maxBodyBytes (default 8 KB).',
        {
            sessionId: z.string(),
            index: z
                .number()
                .int()
                .min(0)
                .describe(
                    'Event index in the session’s capture log (0-based). Matches the index returned by peek_events.',
                ),
            maxBodyBytes: z
                .number()
                .int()
                .min(0)
                .default(8000)
                .describe('Cap on the body string length returned. Default 8 KB.'),
        },
        async ({ sessionId, index, maxBodyBytes }) => {
            const session = requireSession(sessionId);
            const event = session.capture.events[index];
            if (!event) {
                throw new Error(
                    `No event at index ${index}. Session has ${session.capture.events.length} events.`,
                );
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                index,
                                ts: event.ts,
                                direction: event.direction,
                                method: event.method,
                                status: event.status,
                                url: event.url,
                                resourceType: event.resourceType,
                                requestHeaders: event.requestHeaders,
                                responseHeaders: event.responseHeaders,
                                requestBody: truncate(event.requestBody, maxBodyBytes),
                                responseBody: truncate(event.responseBody, maxBodyBytes),
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    server.tool(
        'navigate',
        'Navigate the first Chrome tab of a session to a new URL. Useful when the AI wants to drive the user through a specific flow.',
        {
            sessionId: z.string(),
            url: z.string().url(),
        },
        async ({ sessionId, url }) => {
            const session = requireSession(sessionId);
            const page = session.context.pages()[0] ?? (await session.context.newPage());
            await page.goto(url);

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ sessionId, url, status: 'navigated' }, null, 2),
                    },
                ],
            };
        },
    );

    server.tool(
        'stop_capture',
        'Close the Playwright connection (Chrome window stays open). Optionally writes a HAR file. Returns a summary: total events, status code distribution, top paths.',
        {
            sessionId: z.string(),
            harPath: z
                .string()
                .optional()
                .describe('Absolute path. If provided, a HAR 1.2 file is written here.'),
        },
        async ({ sessionId, harPath }) => {
            const session = requireSession(sessionId);
            await session.capture.stop();

            const summary = summariseEvents(session.capture.events);
            const written = harPath
                ? await writeHar(session.capture.events, harPath).then(() => harPath).catch((e) => `error: ${e.message}`)
                : null;

            await session.browser.close().catch(() => {});
            sessions.delete(sessionId);

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                sessionId,
                                durationMs: Date.now() - session.started.getTime(),
                                ...summary,
                                harPath: written,
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Cleanup on shutdown — disconnect Playwright but leave Chrome windows alive.
    const shutdown = async (): Promise<void> => {
        for (const session of sessions.values()) {
            try {
                await session.capture.stop();
                await session.browser.close();
            } catch {
                // best-effort
            }
        }
        sessions.clear();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

function summariseEvents(events: CapturedEvent[]): {
    totalEvents: number;
    requests: number;
    responses: number;
    statusCounts: Record<string, number>;
    methodCounts: Record<string, number>;
    topPaths: Array<{ path: string; count: number }>;
} {
    const statusCounts: Record<string, number> = {};
    const methodCounts: Record<string, number> = {};
    const pathCounts = new Map<string, number>();
    let requests = 0;
    let responses = 0;

    for (const event of events) {
        if (event.direction === 'request') {
            requests++;
            methodCounts[event.method] = (methodCounts[event.method] ?? 0) + 1;
            try {
                const path = new URL(event.url).pathname;
                pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
            } catch {
                // skip malformed URLs
            }
        } else {
            responses++;
            const key = String(event.status ?? 'unknown');
            statusCounts[key] = (statusCounts[key] ?? 0) + 1;
        }
    }

    const topPaths = Array.from(pathCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([path, count]) => ({ path, count }));

    return {
        totalEvents: events.length,
        requests,
        responses,
        statusCounts,
        methodCounts,
        topPaths,
    };
}
