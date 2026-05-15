import { writeFile } from 'node:fs/promises';
import type { CapturedEvent } from './capture.js';

interface HarEntry {
    startedDateTime: string;
    time: number;
    request: {
        method: string;
        url: string;
        httpVersion: string;
        headers: Array<{ name: string; value: string }>;
        queryString: Array<{ name: string; value: string }>;
        cookies: never[];
        headersSize: number;
        bodySize: number;
        postData?: {
            mimeType: string;
            text: string;
        };
    };
    response: {
        status: number;
        statusText: string;
        httpVersion: string;
        headers: Array<{ name: string; value: string }>;
        cookies: never[];
        content: {
            size: number;
            mimeType: string;
            text?: string;
        };
        redirectURL: string;
        headersSize: number;
        bodySize: number;
    };
    cache: Record<string, never>;
    timings: {
        send: number;
        wait: number;
        receive: number;
    };
}

interface Har {
    log: {
        version: '1.2';
        creator: { name: string; version: string };
        entries: HarEntry[];
    };
}

/**
 * Pair captured request/response events by URL+method and emit a HAR 1.2
 * document. Open the resulting .har in Chrome DevTools (Network → Import)
 * or postman / insomnia.
 */
export async function writeHar(events: CapturedEvent[], outputPath: string): Promise<void> {
    const entries: HarEntry[] = [];
    const pending = new Map<string, CapturedEvent>();

    for (const event of events) {
        const key = `${event.method} ${event.url}`;

        if (event.direction === 'request') {
            pending.set(key, event);
            continue;
        }

        const req = pending.get(key);
        if (!req) {
            // response without a paired request (rare, e.g. captured mid-flight)
            continue;
        }
        pending.delete(key);
        entries.push(buildEntry(req, event));
    }

    const har: Har = {
        log: {
            version: '1.2',
            creator: { name: 'playwright-attach-chrome', version: '0.2.0' },
            entries,
        },
    };

    await writeFile(outputPath, JSON.stringify(har, null, 2), 'utf8');
}

function buildEntry(req: CapturedEvent, res: CapturedEvent): HarEntry {
    const url = new URL(req.url);
    const query = Array.from(url.searchParams.entries()).map(([name, value]) => ({
        name,
        value,
    }));

    const reqHeaders = headersToArray(req.requestHeaders);
    const resHeaders = headersToArray(res.responseHeaders);

    const contentType =
        res.responseHeaders?.['content-type'] ??
        res.responseHeaders?.['Content-Type'] ??
        'application/octet-stream';

    const postContentType =
        req.requestHeaders?.['content-type'] ??
        req.requestHeaders?.['Content-Type'] ??
        'application/x-www-form-urlencoded';

    return {
        startedDateTime: req.ts,
        time: Math.max(0, new Date(res.ts).getTime() - new Date(req.ts).getTime()),
        request: {
            method: req.method,
            url: req.url,
            httpVersion: 'HTTP/1.1',
            headers: reqHeaders,
            queryString: query,
            cookies: [],
            headersSize: -1,
            bodySize: req.requestBody?.length ?? 0,
            ...(req.requestBody ? { postData: { mimeType: postContentType, text: req.requestBody } } : {}),
        },
        response: {
            status: res.status ?? 0,
            statusText: '',
            httpVersion: 'HTTP/1.1',
            headers: resHeaders,
            cookies: [],
            content: {
                size: res.responseBody?.length ?? 0,
                mimeType: contentType,
                ...(res.responseBody !== null && res.responseBody !== undefined
                    ? { text: res.responseBody }
                    : {}),
            },
            redirectURL: '',
            headersSize: -1,
            bodySize: res.responseBody?.length ?? 0,
        },
        cache: {},
        timings: {
            send: 0,
            wait: Math.max(0, new Date(res.ts).getTime() - new Date(req.ts).getTime()),
            receive: 0,
        },
    };
}

function headersToArray(
    headers: Record<string, string> | undefined,
): Array<{ name: string; value: string }> {
    if (!headers) return [];
    return Object.entries(headers).map(([name, value]) => ({ name, value }));
}
