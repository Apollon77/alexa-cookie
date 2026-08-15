const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const querystring = require('querystring');
const vm = require('vm');

const testName = 'proxy-embedded-url-rewrite';
const outputDir = process.env.ALEXA_COOKIE_TEST_OUTPUT_DIR || path.join(__dirname, '..', 'test-output');
const outputFile = path.join(outputDir, `${testName}.txt`);
const lines = [];

function line(value = '') {
    lines.push(value);
}

function writeOutput() {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputFile, `${lines.join('\n')}\n`);
}

function recordAssertion(description, fn) {
    try {
        fn();
        line(`${description}: PASS`);
    } catch (err) {
        line(`${description}: FAIL`);
        writeOutput();
        throw err;
    }
}

const proxyFile = path.join(__dirname, '..', 'lib', 'proxy.js');
const source = fs.readFileSync(proxyFile, 'utf8');

let capturedProxyOptions;
let capturedProxyMiddleware;
let capturedMiddlewares;

function createExpressStub() {
    return {
        use(handler) {
            capturedMiddlewares.push(handler);
        },
        get() {},
        listen() {
            const server = {
                address: () => ({ port: 3456 }),
                on: () => server
            };
            return server;
        }
    };
}

function loadProxyModule() {
    capturedProxyOptions = undefined;
    capturedProxyMiddleware = undefined;
    capturedMiddlewares = [];
    const module = { exports: {} };
    const sandbox = {
        Buffer,
        URL,
        // rewriteProxyPath() un-rewrites query parameters with URLSearchParams; without it in
        // the sandbox the code under test silently falls back to the unmodified path.
        URLSearchParams,
        __dirname: path.dirname(proxyFile),
        console,
        module,
        exports: module.exports,
        require(name) {
            if (name === 'express') return createExpressStub;
            if (name === 'http-proxy-response-rewrite') return () => {};
            if (name === 'http-proxy-middleware') {
                return {
                    createProxyMiddleware(_context, options) {
                        capturedProxyOptions = options;
                        capturedProxyMiddleware = function proxyMiddleware() {};
                        return capturedProxyMiddleware;
                    }
                };
            }
            if (name === 'cookie') {
                return { parse: () => ({}) };
            }
            return require(name);
        }
    };
    vm.runInNewContext(source, sandbox, { filename: proxyFile });
    return module.exports;
}

function applyPathRewrite(pathname, req) {
    const rewrite = capturedProxyOptions.pathRewrite;
    if (typeof rewrite === 'function') return rewrite(pathname, req);
    for (const pattern of Object.keys(rewrite)) {
        const regex = new RegExp(pattern);
        if (regex.test(pathname)) return pathname.replace(regex, rewrite[pattern]);
    }
    return pathname;
}

function createProxyReqStub(headers = {}) {
    const written = [];
    const stored = { ...headers };
    return {
        written,
        getHeaders: () => ({ ...stored }),
        getHeader: name => stored[name.toLowerCase()],
        setHeader(name, value) {
            stored[name.toLowerCase()] = value;
        },
        write(chunk) {
            written.push(chunk);
        }
    };
}

// A minimal readable request: `on()` records listeners so the body can be emitted on demand.
function createReqStub({ method, url, headers }) {
    const listeners = {};
    return {
        method,
        url,
        headers,
        listeners,
        on(event, handler) {
            listeners[event] = handler;
            return this;
        }
    };
}

// Drives the buffering middleware the same way express would: hand it the request, then let
// the request stream emit its body.
function runBufferMiddleware(middleware, req, rawBody) {
    // Nothing mounted ahead of the proxy: report it instead of crashing, so a run against an
    // unpatched lib/proxy.js still produces the assertion report below.
    if (typeof middleware !== 'function') return false;
    let nextCalled = false;
    middleware(req, {}, () => {
        nextCalled = true;
    });
    if (req.listeners.data && rawBody) req.listeners.data(Buffer.from(rawBody));
    if (req.listeners.end) req.listeners.end();
    return nextCalled;
}

const proxyModule = loadProxyModule();
const formerDataStorePath = path.join(os.tmpdir(), `alexa-cookie-proxy-embedded-url-test-${Date.now()}.json`);

try {
    const input = {
        proxyOwnIp: '127.0.0.1',
        proxyPort: 3456,
        proxyListenBind: '0.0.0.0',
        baseAmazonPage: 'amazon.de',
        baseAmazonPageHandle: '_de',
        amazonPageProxyLanguage: 'de_DE',
        acceptLanguage: 'de-DE',
        proxyLogLevel: 'silent',
        formerDataStorePath
    };
    proxyModule.initAmazonProxy(input);

    const bufferMiddleware = capturedMiddlewares.filter(handler => handler !== capturedProxyMiddleware)[0];

    // --- GET: `openid.return_to` pointing back at the proxy (the #137 polling loop) ---
    const pollReq = {
        method: 'GET',
        url: '/www.amazon.com/ap/cvf/approval/poll?openid.return_to=http%3A%2F%2F127.0.0.1%3A3456%2Fwww.amazon.com%2Fap%2Fmaplanding&pageId=amzn_dp_project_dee_ios_de',
        headers: { host: '127.0.0.1:3456' }
    };
    const pollRewritten = applyPathRewrite(pollReq.url, pollReq);
    const pollParams = new URLSearchParams(pollRewritten.slice(pollRewritten.indexOf('?') + 1));

    // --- GET: a query with nothing to fix must come through byte-identical ---
    const cleanReq = {
        method: 'GET',
        url: '/www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2Fap%2Fmaplanding&language=de_DE',
        headers: { host: '127.0.0.1:3456' }
    };
    const cleanRewritten = applyPathRewrite(cleanReq.url, cleanReq);

    // --- POST: `openid.return_to` in an url-encoded body (the verifyOtp 404) ---
    const otpBody = 'openid.return_to=http%3A%2F%2F127.0.0.1%3A3456%2Fwww.amazon.com%2Fap%2Fmaplanding&code=123456';
    const otpReq = createReqStub({
        method: 'POST',
        url: '/ap/cvf/approval/verifyOtp',
        headers: {
            host: '127.0.0.1:3456',
            'content-type': 'application/x-www-form-urlencoded'
        }
    });
    const otpNextCalled = runBufferMiddleware(bufferMiddleware, otpReq, otpBody);
    const otpParsedBody = { ...otpReq.body };
    const otpProxyReq = createProxyReqStub({ host: 'www.amazon.com', 'content-length': String(Buffer.byteLength(otpBody)) });
    capturedProxyOptions.onProxyReq(otpProxyReq, otpReq);
    const otpForwarded = otpProxyReq.written.join('');
    const otpForwardedFields = querystring.parse(otpForwarded);

    // --- POST: a non-urlencoded body must not be buffered, parsed or re-sent ---
    const jsonReq = createReqStub({
        method: 'POST',
        url: '/ap/cvf/approval/poll',
        headers: {
            host: '127.0.0.1:3456',
            'content-type': 'application/json'
        }
    });
    const jsonNextCalled = runBufferMiddleware(bufferMiddleware, jsonReq, '{"foo":"bar"}');
    const jsonProxyReq = createProxyReqStub({ host: 'www.amazon.com' });
    capturedProxyOptions.onProxyReq(jsonProxyReq, jsonReq);

    line('TEST: proxy embedded url rewrite (regression for #137)');
    line('');
    line('CODE UNDER TEST:');
    line('- lib/proxy.js: rewriteProxyPath() / fixEmbeddedProxyUrls()');
    line('- lib/proxy.js: bufferUrlencodedBody()');
    line('- lib/proxy.js: onProxyReq() POST body handling');
    line('');
    line('INPUT:');
    line(`proxy base: http://${input.proxyOwnIp}:${input.proxyPort}/`);
    line(`GET poll url: ${pollReq.url}`);
    line(`GET clean url: ${cleanReq.url}`);
    line(`POST verifyOtp body: ${otpBody}`);
    line('POST json content-type: application/json');
    line('');
    line('OBSERVED:');
    line(`middlewares mounted before proxy: ${capturedMiddlewares.length - 1}`);
    line(`GET poll rewritten: ${pollRewritten}`);
    line(`GET poll openid.return_to: ${pollParams.get('openid.return_to')}`);
    line(`GET clean rewritten: ${cleanRewritten}`);
    line(`POST buffer middleware called next(): ${otpNextCalled}`);
    line(`POST parsed body: ${JSON.stringify(otpParsedBody)}`);
    line(`POST forwarded body: ${otpForwarded}`);
    line(`POST forwarded content-length: ${otpProxyReq.getHeader('content-length')}`);
    line(`POST json parsed body: ${JSON.stringify(jsonReq.body)}`);
    line(`POST json forwarded chunks: ${jsonProxyReq.written.length}`);
    line(`POST json content-length: ${jsonProxyReq.getHeader('content-length')}`);
    line('');
    line('ASSERTIONS:');
    recordAssertion('GET path is stripped of the proxy host prefix', () => {
        assert.strictEqual(pollRewritten.split('?')[0], '/ap/cvf/approval/poll');
    });
    recordAssertion('GET query openid.return_to points back at amazon.com', () => {
        assert.strictEqual(pollParams.get('openid.return_to'), 'https://www.amazon.com/ap/maplanding');
    });
    recordAssertion('GET query keeps the untouched parameters', () => {
        assert.strictEqual(pollParams.get('pageId'), 'amzn_dp_project_dee_ios_de');
    });
    recordAssertion('GET query without proxy urls is returned unchanged', () => {
        assert.strictEqual(cleanRewritten, '/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2Fap%2Fmaplanding&language=de_DE');
    });
    recordAssertion('one middleware is mounted ahead of the proxy middleware', () => {
        assert.strictEqual(capturedMiddlewares.length - 1, 1);
        assert.strictEqual(typeof bufferMiddleware, 'function');
    });
    recordAssertion('urlencoded POST body is buffered and parsed before next()', () => {
        assert.strictEqual(otpNextCalled, true);
        assert.strictEqual(otpParsedBody['openid.return_to'], 'http://127.0.0.1:3456/www.amazon.com/ap/maplanding');
        assert.strictEqual(otpParsedBody.code, '123456');
    });
    recordAssertion('POST body openid.return_to points back at amazon.com', () => {
        assert.strictEqual(otpForwardedFields['openid.return_to'], 'https://www.amazon.com/ap/maplanding');
    });
    recordAssertion('POST body keeps the untouched fields', () => {
        assert.strictEqual(otpForwardedFields.code, '123456');
    });
    recordAssertion('POST forwarded body is written exactly once', () => {
        assert.strictEqual(otpProxyReq.written.length, 1);
    });
    recordAssertion('POST content-length matches the forwarded body', () => {
        assert.strictEqual(Number(otpProxyReq.getHeader('content-length')), Buffer.byteLength(otpForwarded));
        assert.notStrictEqual(Buffer.byteLength(otpForwarded), Buffer.byteLength(otpBody));
    });
    recordAssertion('non-urlencoded POST is passed through untouched', () => {
        assert.strictEqual(jsonNextCalled, true);
        assert.strictEqual(jsonReq.body, undefined);
        assert.strictEqual(jsonProxyReq.written.length, 0);
        assert.strictEqual(jsonProxyReq.getHeader('content-length'), undefined);
    });
    line('');
    line('RESULT: PASS');
    writeOutput();
} catch (err) {
    if (!lines.includes('RESULT: PASS')) {
        line('');
        line('RESULT: FAIL');
        writeOutput();
    }
    throw err;
} finally {
    fs.rmSync(formerDataStorePath, { force: true });
}
