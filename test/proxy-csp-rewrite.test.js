const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const testName = 'proxy-csp-rewrite';
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

function createExpressStub() {
    return {
        use() {},
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
    const module = { exports: {} };
    const sandbox = {
        Buffer,
        URL,
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
                        return function proxyMiddleware() {};
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

const proxyModule = loadProxyModule();
const formerDataStorePath = path.join(os.tmpdir(), `alexa-cookie-proxy-csp-test-${Date.now()}.json`);

try {
    proxyModule.initAmazonProxy({
        proxyOwnIp: '127.0.0.1',
        proxyPort: 3456,
        proxyListenBind: '0.0.0.0',
        baseAmazonPage: 'amazon.de',
        baseAmazonPageHandle: '_de',
        formerDataStorePath
    });

    const cases = [
        ['upgrade-insecure-requests;report-uri https://metrics.media-amazon.com/', ';report-uri https://metrics.media-amazon.com/'],
        ["default-src 'self'; upgrade-insecure-requests; frame-ancestors 'none'", "default-src 'self'; frame-ancestors 'none'"],
        ["frame-ancestors 'none'; UPGRADE-INSECURE-REQUESTS ", "frame-ancestors 'none'"],
        ['upgrade-insecure-requests', ''],
        ["frame-ancestors 'none';", "frame-ancestors 'none';"],
        ['report-uri /upgrade-insecure-requests', 'report-uri /upgrade-insecure-requests'],
        [undefined, undefined]
    ];

    line('TEST: HTTP proxy CSP rewrite');
    // Static responses also pass through this hook, before its URL-based early returns.
    for (const url of ['/ax/claim', '/asset.js']) {
        for (const [policy, expected] of cases) {
            recordAssertion(`${url}: ${policy || 'no CSP'}`, () => {
                const headers = {
                    'content-security-policy-report-only': 'upgrade-insecure-requests; report-uri /report',
                    'content-type': 'text/html'
                };
                if (policy !== undefined) headers['content-security-policy'] = policy;
                const proxyRes = { headers };
                capturedProxyOptions.onProxyRes(proxyRes, { url }, {});
                assert.strictEqual(headers['content-security-policy'], expected);
                assert.strictEqual(headers['content-security-policy-report-only'], 'upgrade-insecure-requests; report-uri /report');
                assert.strictEqual(headers['content-type'], 'text/html');
                if (policy === undefined) {
                    assert.ok(!Object.prototype.hasOwnProperty.call(headers, 'content-security-policy'));
                }
            });
        }
    }
    line('RESULT: PASS');
    writeOutput();
} catch (err) {
    line('RESULT: FAIL');
    writeOutput();
    throw err;
} finally {
    fs.rmSync(formerDataStorePath, { force: true });
}
