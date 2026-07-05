const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const testName = 'proxy-host-switch';
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

function applyPathRewrite(pathname, req) {
    const rewrite = capturedProxyOptions.pathRewrite;
    if (typeof rewrite === 'function') return rewrite(pathname, req);
    for (const pattern of Object.keys(rewrite)) {
        const regex = new RegExp(pattern);
        if (regex.test(pathname)) return pathname.replace(regex, rewrite[pattern]);
    }
    return pathname;
}

const proxyModule = loadProxyModule();
const formerDataStorePath = path.join(os.tmpdir(), `alexa-cookie-proxy-host-test-${Date.now()}.json`);

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

    const directReq = {
        method: 'GET',
        url: '/www.amazon.com/ap/signin',
        headers: { host: '127.0.0.1:3456' }
    };
    const refererReq = {
        method: 'POST',
        url: '/ap/cvf/verify',
        headers: {
            host: '127.0.0.1:3456',
            referer: 'http://127.0.0.1:3456/www.amazon.com/ap/signin'
        }
    };

    const directTarget = capturedProxyOptions.router(directReq);
    const directRewrittenPath = applyPathRewrite(directReq.url, directReq);
    const refererTarget = capturedProxyOptions.router(refererReq);

    line('TEST: proxy host switch');
    line('');
    line('CODE UNDER TEST:');
    line('- lib/proxy.js: router()');
    line('- lib/proxy.js: rewriteProxyPath()');
    line('');
    line('INPUT:');
    line(`baseAmazonPage: ${input.baseAmazonPage}`);
    line(`direct request url: ${directReq.url}`);
    line(`referer request url: ${refererReq.url}`);
    line(`referer header: ${refererReq.headers.referer}`);
    line('');
    line('OBSERVED:');
    line(`direct router target: ${directTarget}`);
    line(`direct rewritten path: ${directRewrittenPath}`);
    line(`referer router target: ${refererTarget}`);
    line('');
    line('ASSERTIONS:');
    recordAssertion('direct router target === "https://www.amazon.com"', () => {
        assert.strictEqual(directTarget, 'https://www.amazon.com');
    });
    recordAssertion('direct rewritten path === "/ap/signin"', () => {
        assert.strictEqual(directRewrittenPath, '/ap/signin');
    });
    recordAssertion('referer router target === "https://www.amazon.com"', () => {
        assert.strictEqual(refererTarget, 'https://www.amazon.com');
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
