const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const testName = 'proxy-csp-upgrade-strip';
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

function runOnProxyRes(headers) {
    const proxyRes = { headers, socket: undefined };
    const req = { originalUrl: '/ax/claim' };
    const res = {};
    capturedProxyOptions.onProxyRes(proxyRes, req, res);
    return proxyRes.headers;
}

const proxyModule = loadProxyModule();
const formerDataStorePath = path.join(os.tmpdir(), `alexa-cookie-proxy-csp-test-${Date.now()}.json`);

try {
    const input = {
        proxyOwnIp: '127.0.0.1',
        proxyPort: 3456,
        proxyListenBind: '0.0.0.0',
        baseAmazonPage: 'amazon.com',
        baseAmazonPageHandle: '',
        amazonPageProxyLanguage: 'en_US',
        acceptLanguage: 'en-US',
        proxyLogLevel: 'silent',
        formerDataStorePath
    };
    proxyModule.initAmazonProxy(input);
    assert.ok(capturedProxyOptions && typeof capturedProxyOptions.onProxyRes === 'function', 'onProxyRes hook must be exported in proxy options');

    const amazonCsp = 'upgrade-insecure-requests;report-uri https://metrics.media-amazon.com/';
    const strictCsp = "frame-ancestors 'none';";
    const mixedCsp = "default-src 'self'; upgrade-insecure-requests; report-uri https://metrics.media-amazon.com/";

    line('TEST: proxy CSP upgrade-insecure-requests strip');
    line('');
    line('CODE UNDER TEST:');
    line('- lib/proxy.js: onProxyRes content-security-policy handling');
    line('- lib/proxy.js: onProxyRes strict-transport-security handling');
    line('');
    line('INPUT:');
    line(`CSP header from Amazon: ${amazonCsp}`);
    line(`HSTS header from Amazon: max-age=47474747; includeSubDomains; preload`);
    line('');
    line('OBSERVED:');

    const headers = runOnProxyRes({
        'content-security-policy': amazonCsp,
        'strict-transport-security': 'max-age=47474747; includeSubDomains; preload'
    });
    line(`CSP after onProxyRes: ${headers['content-security-policy']}`);
    line(`HSTS after onProxyRes: ${headers['strict-transport-security']}`);

    line('');
    line('ASSERTIONS:');
    recordAssertion('upgrade-insecure-requests directive is removed from CSP', () => {
        assert.strictEqual(headers['content-security-policy'], 'report-uri https://metrics.media-amazon.com/');
    });
    recordAssertion('other CSP directives are retained', () => {
        assert.ok(headers['content-security-policy'].includes('report-uri'), 'report-uri directive must be kept');
    });
    recordAssertion('strict-transport-security is not forwarded', () => {
        assert.strictEqual(headers['strict-transport-security'], undefined);
    });
    recordAssertion('CSP without the directive is left unchanged', () => {
        const result = runOnProxyRes({ 'content-security-policy': strictCsp });
        assert.strictEqual(result['content-security-policy'], strictCsp);
    });
    recordAssertion('mixed CSP keeps unrelated directives', () => {
        const result = runOnProxyRes({ 'content-security-policy': mixedCsp });
        assert.strictEqual(result['content-security-policy'], "default-src 'self'; report-uri https://metrics.media-amazon.com/");
    });
    recordAssertion('directive match is case-insensitive', () => {
        const result = runOnProxyRes({ 'content-security-policy': 'UPGRADE-INSECURE-REQUESTS' });
        assert.strictEqual(result['content-security-policy'], undefined);
    });
    recordAssertion('CSP containing only the directive is deleted entirely', () => {
        const result = runOnProxyRes({ 'content-security-policy': 'upgrade-insecure-requests' });
        assert.strictEqual(result['content-security-policy'], undefined);
    });
    recordAssertion('response without CSP/HSTS headers passes through untouched', () => {
        const result = runOnProxyRes({ 'set-cookie': ['session-id=abc; Path=/; Secure'] });
        assert.deepStrictEqual(Object.keys(result), ['set-cookie']);
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
