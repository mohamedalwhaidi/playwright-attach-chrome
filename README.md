# playwright-attach-chrome

> Drive a **real Chrome window** with Playwright. Capture, filter, and export every network request the page makes — JSON / NDJSON / HAR. MIT.

[![npm](https://img.shields.io/npm/v/playwright-attach-chrome.svg)](https://www.npmjs.com/package/playwright-attach-chrome)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[العربية ↓](#عربي)

---

## Why

Playwright normally launches its own ephemeral Chromium. That means **no cookies, no logins, no extensions** from your real browser. If you want to reverse-engineer an internal API of a SaaS you're already logged into, that's a hard wall.

This package launches Chrome with a **persistent user-data-dir** and **`--remote-debugging-port`**, then connects Playwright to it via CDP. You log in once, Chrome remembers you forever (the cookies live in the data dir), and Playwright sees every request the page makes.

Works on macOS, Linux, and Windows. Auto-detects Chrome / Chromium / Edge / Brave.

## How it works

```mermaid
sequenceDiagram
    autonumber
    actor You
    participant CLI as pac (CLI)
    participant Chrome
    participant Site as Target site

    You->>CLI: pac capture --url X --user-data-dir P --har out.har
    CLI->>CLI: locate Chrome binary on disk
    CLI->>CLI: check port 9222 is free
    CLI->>Chrome: spawn Chrome with<br/>--remote-debugging-port=9222<br/>--user-data-dir=P
    Chrome-->>CLI: CDP endpoint ready
    CLI->>Chrome: Playwright connectOverCDP
    CLI->>Chrome: subscribe request / response events
    CLI->>Chrome: navigate first tab to X

    rect rgb(230, 245, 255)
        Note over You,Site: You drive the browser manually
        You->>Chrome: type, click, scroll
        Chrome->>Site: XHR / fetch / GraphQL
        Site-->>Chrome: JSON / HTML responses
        Chrome-->>CLI: every req+res over CDP
        CLI->>CLI: filter by URL, buffer, stream NDJSON
    end

    You->>CLI: Ctrl-C
    CLI->>CLI: write HAR file
    CLI-->>You: out.har on disk
    Note over Chrome: Chrome window stays open<br/>for you to keep using
```

### First run vs later runs

The CLI's secret weapon is the `--user-data-dir` flag — it points Chrome at a folder where it stores cookies, localStorage, extensions, history. Reuse the same folder across runs and your login persists.

```mermaid
flowchart LR
    Start([pac capture<br/>--user-data-dir ~/.my-profile]) --> Q{Profile dir<br/>exists?}
    Q -->|No, first run| Empty[Empty Chrome profile]
    Empty --> Login[You log in once<br/>in the Chrome window]
    Login --> Save[Cookies saved to<br/>~/.my-profile]
    Save --> Cap[Capture & navigate]

    Q -->|Yes, returning| Hot[Profile already has<br/>your cookies]
    Hot --> Already[Auto-logged-in<br/>on next launch]
    Already --> Cap

    Cap --> Done([Ctrl-C → HAR written])

    style Login fill:#fff4cc
    style Already fill:#ccf2cc
```

## Install

```bash
npm install -g playwright-attach-chrome
# or run without install:
npx playwright-attach-chrome capture --url https://example.com
```

## Quick start — CLI

```bash
# Launch Chrome at a URL, capture every request, save to HAR:
pac capture \
  --url https://business.gathern.co \
  --filter api.gathern.co \
  --har gathern.har \
  --user-data-dir ~/.gathern-profile
```

You'll see Chrome open. **Log in once.** Click around. Every matching request is printed live:

```
→ GET    https://api.gathern.co/v1/business/chalet/list?access-token=...
← 200    https://api.gathern.co/v1/business/chalet/list?access-token=...
→ POST   https://api.gathern.co/v1/business/reservation/filter
← 200    https://api.gathern.co/v1/business/reservation/filter
```

Press Ctrl-C — `gathern.har` is written. Open it in Chrome DevTools (Network tab → drag-and-drop) or Postman / Insomnia.

Reuse the same `--user-data-dir` next time and you skip the login.

### CLI flags

| Flag | Description |
| --- | --- |
| `--url <url>` | URL to open in the first tab |
| `--filter <pattern>` | Substring (e.g. `api.gathern.co`) or `/regex/` (e.g. `/\\/api\\/v\\d/`) |
| `--har <path>` | Write a HAR 1.2 file on exit |
| `--ndjson <path>` | Stream every event as NDJSON (one JSON per line) |
| `--user-data-dir <path>` | Persistent profile dir. Reuse across runs to keep the login. |
| `--port <number>` | CDP port (default 9222) |
| `--chrome-path <path>` | Manual Chrome binary path |
| `--no-bodies` | Skip request/response bodies (saves memory) |
| `--max-body-bytes <n>` | Truncate bodies larger than n bytes (default 1 MB) |
| `--quiet` | Don't print the live log |

### Attach to an already-running Chrome

If you've already launched Chrome with `--remote-debugging-port=9222` yourself:

```bash
pac attach --port 9222 --filter api.gathern.co --har out.har
```

Useful when you want to debug a session that's already in progress without restarting Chrome.

## Quick start — library

```ts
import { launchChrome, attach, captureContext, writeHar } from 'playwright-attach-chrome';

const chrome = await launchChrome({
    startUrl: 'https://business.gathern.co',
    userDataDir: '/Users/me/.gathern-profile', // persistent: keep login
});

const { browser, defaultContext } = await attach({ cdpUrl: chrome.cdpUrl });

const capture = captureContext(defaultContext, {
    filter: 'api.gathern.co',
    onEvent: (e) => console.log(e.direction, e.method, e.url, e.status),
});

// ...let the user navigate, then:
process.on('SIGINT', async () => {
    await capture.stop();
    await writeHar(capture.events, 'gathern.har');
    await browser.close();
    process.exit(0);
});

await new Promise(() => {}); // park
```

## The trick (for anyone curious)

Chrome only allows DevTools Protocol attach on **a profile that was launched with the flag**. Your normal Chrome — the one with your real Gmail, Drive, banking tabs — is **not attachable**, on purpose: Chrome blocks it so a hostile script can't silently steal your cookies.

The workaround is a **parallel Chrome profile**:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir=$HOME/.my-capture-profile
```

That spawns a separate Chrome window with its own cookies, extensions, and bookmarks. You log in *there* once. Persisted. Playwright connects to that one.

This package wraps that ceremony so you can stop typing the flag soup.

## Caveats

- **Can't attach to your real Chrome.** That's a hard CDP rule, not a bug here.
- **First run = log in once.** After that, reuse the same `--user-data-dir` and you're in.
- **Bodies are stored in memory.** Long sessions on heavy sites can grow. Use `--max-body-bytes` or `--no-bodies`.
- **Cleanup is your call.** The CLI leaves the Chrome window open when you Ctrl-C, so you can keep using it. Quit Chrome manually when done.

## License

MIT.

---

<a id="عربي"></a>

# playwright-attach-chrome — العربية

> شغّل Playwright على نافذة Chrome حقيقية. التقط طلبات الشبكة وفلترها واحفظها بصيغة JSON / NDJSON / HAR.

## ليش

Playwright عادةً يفتح متصفح Chromium مؤقت بدون كوكيز ولا حسابك المسجّل. لو تبي تتجسس على API داخلي لخدمة أنت أصلًا داخل عليها (Gathern مثلًا)، هذا يقطع الطريق.

الأداة هذي تشغّل Chrome **بملف تعريف ثابت** على المنفذ ‎9222‎ (CDP)، ثم تربط Playwright عليه. تسجّل دخولك مرة وحدة، وChrome يحفظك للأبد (الكوكيز محفوظة في مجلد البروفايل)، وPlaywright يشوف كل طلب يطلع من الصفحة.

تدعم macOS و Linux و Windows. تكتشف Chrome / Chromium / Edge / Brave تلقائيًا.

## كيف تشتغل (شرح بصري)

```mermaid
sequenceDiagram
    autonumber
    actor You as أنت
    participant CLI as pac (الأداة)
    participant Chrome
    participant Site as الموقع المستهدف

    You->>CLI: pac capture --url X --user-data-dir P --har out.har
    CLI->>CLI: تحديد مسار Chrome على الجهاز
    CLI->>CLI: التأكد إن المنفذ 9222 شاغر
    CLI->>Chrome: تشغيل Chrome مع<br/>--remote-debugging-port=9222<br/>--user-data-dir=P
    Chrome-->>CLI: نقطة CDP جاهزة
    CLI->>Chrome: Playwright connectOverCDP
    CLI->>Chrome: الاشتراك بأحداث الطلبات والردود
    CLI->>Chrome: الانتقال للرابط X

    rect rgb(230, 245, 255)
        Note over You,Site: أنت تتصفح يدويًا
        You->>Chrome: كتابة، نقر، تمرير
        Chrome->>Site: XHR / fetch / GraphQL
        Site-->>Chrome: ردود JSON / HTML
        Chrome-->>CLI: كل طلب ورد عبر CDP
        CLI->>CLI: فلترة، تخزين، بث NDJSON
    end

    You->>CLI: Ctrl-C
    CLI->>CLI: كتابة ملف HAR
    CLI-->>You: out.har على القرص
    Note over Chrome: نافذة Chrome تبقى مفتوحة<br/>لتكمل عليها
```

### المرة الأولى مقابل المرات اللاحقة

سر الأداة هو `--user-data-dir` — مجلد يحتفظ Chrome فيه بالكوكيز و localStorage و الإضافات. استخدم نفس المجلد في كل مرة، ويبقى حسابك مسجّلًا.

```mermaid
flowchart LR
    Start([pac capture<br/>--user-data-dir ~/.my-profile]) --> Q{المجلد<br/>موجود؟}
    Q -->|لا، أول مرة| Empty[بروفايل Chrome فارغ]
    Empty --> Login[تسجّل دخولك مرة وحدة<br/>في نافذة Chrome]
    Login --> Save[تُحفظ الكوكيز في<br/>~/.my-profile]
    Save --> Cap[التقاط وتصفح]

    Q -->|نعم، مرة لاحقة| Hot[المجلد يحوي<br/>كوكيزك أصلاً]
    Hot --> Already[تدخل مباشرة<br/>بدون تسجيل دخول]
    Already --> Cap

    Cap --> Done([Ctrl-C يكتب ملف HAR])

    style Login fill:#fff4cc
    style Already fill:#ccf2cc
```

## التثبيت

```bash
npm install -g playwright-attach-chrome
# أو بدون تثبيت:
npx playwright-attach-chrome capture --url https://example.com
```

## استعمال سريع — أوامر طرفية

```bash
pac capture \
  --url https://business.gathern.co \
  --filter api.gathern.co \
  --har gathern.har \
  --user-data-dir ~/.gathern-profile
```

يفتح Chrome. **سجّل دخولك مرة وحدة.** تجوّل في الموقع. كل طلب يطابق الفلتر يظهر في الطرفية مباشرة.

اضغط Ctrl-C — يُكتب ملف `gathern.har`. افتحه في Chrome DevTools (سحب وإفلات على لسان Network) أو في Postman / Insomnia.

استخدم نفس `--user-data-dir` في المرة الجاية تتفادى تسجيل الدخول.

## الحيلة (لو تحب تفهم)

Chrome يرفض الاتصال عبر DevTools Protocol على **بروفايلك الأصلي** — البروفايل اللي فيه جيميل والبنك وكل شي — أمنيًا، حتى لا يقدر سكربت خبيث يسرق كوكيزك بصمت.

الحل: **بروفايل Chrome موازي**:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir=$HOME/.my-capture-profile
```

نافذة Chrome ثانية، كوكيزها وحساباتها مستقلة. تسجّل دخولك فيها. وPlaywright يربط عليها.

الأداة هذي تختصر عليك كتابة هذا كله.

## ملاحظات مهمة

- **ما تقدر تربط على Chrome العادي** — قاعدة من Chrome نفسه، مو من الأداة.
- **سجّل دخولك أول مرة فقط** — أعد استخدام نفس `--user-data-dir` لاحقًا.
- **الأجسام (bodies) تتخزن في الذاكرة** — للجلسات الطويلة استخدم `--max-body-bytes` أو `--no-bodies`.
- **التنظيف عليك** — لما تضغط Ctrl-C، نافذة Chrome تبقى مفتوحة لتكمل عملك. اقفلها يدويًا.

## الترخيص

MIT.
