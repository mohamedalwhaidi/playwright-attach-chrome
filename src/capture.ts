import { createWriteStream, type WriteStream } from 'node:fs';
import type { BrowserContext, Page, Request, Response } from 'playwright-core';

export interface CapturedEvent {
    ts: string;
    direction: 'request' | 'response';
    method: string;
    url: string;
    status?: number;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    requestBody?: string | null;
    responseBody?: string | null;
    resourceType?: string;
}

export interface CaptureOptions {
    /** Substring or RegExp the URL must match. */
    filter?: string | RegExp;
    /** Include request headers. Default true. */
    includeRequestHeaders?: boolean;
    /** Include response headers. Default true. */
    includeResponseHeaders?: boolean;
    /** Include request body. Default true. */
    includeRequestBody?: boolean;
    /** Include response body. Default true. */
    includeResponseBody?: boolean;
    /** Max response body size in bytes (UTF-8). Larger bodies are truncated. */
    maxBodyBytes?: number;
    /** If set, append each event as NDJSON to this file path. */
    outputNdjson?: string;
    /** Called for each captured event. */
    onEvent?: (event: CapturedEvent) => void;
}

const DEFAULTS = {
    includeRequestHeaders: true,
    includeResponseHeaders: true,
    includeRequestBody: true,
    includeResponseBody: true,
    maxBodyBytes: 1_000_000,
} as const;

export interface CaptureHandle {
    /** Stop listening and close the output file (if any). */
    stop: () => Promise<void>;
    /** In-memory list of all captured events. */
    events: CapturedEvent[];
}

/**
 * Subscribe to every request/response in a Playwright context, optionally
 * filtering by URL pattern. Pairs requests with their responses but emits
 * each as a separate event so streams stay flush-friendly.
 */
export function captureContext(
    context: BrowserContext,
    opts: CaptureOptions = {},
): CaptureHandle {
    const settings = { ...DEFAULTS, ...opts };
    const events: CapturedEvent[] = [];

    let stream: WriteStream | null = null;
    if (opts.outputNdjson) {
        stream = createWriteStream(opts.outputNdjson, { flags: 'a' });
    }

    const matches = (url: string): boolean => {
        if (!opts.filter) return true;
        return typeof opts.filter === 'string'
            ? url.includes(opts.filter)
            : opts.filter.test(url);
    };

    const emit = (event: CapturedEvent): void => {
        events.push(event);
        opts.onEvent?.(event);
        if (stream) {
            stream.write(JSON.stringify(event) + '\n');
        }
    };

    const onRequest = async (req: Request): Promise<void> => {
        if (!matches(req.url())) return;

        let requestBody: string | null = null;
        if (settings.includeRequestBody) {
            const post = req.postData();
            requestBody = post === null ? null : truncate(post, settings.maxBodyBytes);
        }

        emit({
            ts: new Date().toISOString(),
            direction: 'request',
            method: req.method(),
            url: req.url(),
            requestHeaders: settings.includeRequestHeaders ? await safeHeaders(req) : undefined,
            requestBody,
            resourceType: req.resourceType(),
        });
    };

    const onResponse = async (res: Response): Promise<void> => {
        if (!matches(res.url())) return;

        let responseBody: string | null = null;
        if (settings.includeResponseBody) {
            try {
                const buf = await res.body();
                responseBody = truncate(buf.toString('utf8'), settings.maxBodyBytes);
            } catch {
                responseBody = null;
            }
        }

        emit({
            ts: new Date().toISOString(),
            direction: 'response',
            method: res.request().method(),
            url: res.url(),
            status: res.status(),
            responseHeaders: settings.includeResponseHeaders ? await safeResponseHeaders(res) : undefined,
            responseBody,
            resourceType: res.request().resourceType(),
        });
    };

    const onPage = (page: Page): void => {
        page.on('request', (req) => {
            void onRequest(req);
        });
        page.on('response', (res) => {
            void onResponse(res);
        });
    };

    for (const page of context.pages()) {
        onPage(page);
    }
    context.on('page', onPage);

    return {
        events,
        stop: async () => {
            context.off('page', onPage);
            if (stream) {
                await new Promise<void>((resolve) => stream!.end(resolve));
            }
        },
    };
}

async function safeHeaders(req: Request): Promise<Record<string, string>> {
    try {
        return await req.allHeaders();
    } catch {
        return req.headers();
    }
}

async function safeResponseHeaders(res: Response): Promise<Record<string, string>> {
    try {
        return await res.allHeaders();
    } catch {
        return res.headers();
    }
}

function truncate(body: string, max: number): string {
    if (body.length <= max) return body;
    return body.slice(0, max) + `…[truncated ${body.length - max} bytes]`;
}
