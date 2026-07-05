const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const testName = 'proxy-random-port';
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

const ASSIGNED_PORT = 3456;
let capturedProxyOptions;

function createExpressStub() {
    return {
        use() {},
        get() {},
        listen(port, bind, callback) {
            const server = {
                address: () => ({ port: ASSIGNED_PORT }),
                on: () => server
            };
            callback && callback.call(server);
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
const formerDataStorePath = path.join(os.tmpdir(), `alexa-cookie-proxy-random-port-test-${Date.now()}.json`);

try {
    const input = {
        proxyOwnIp: '127.0.0.1',
        proxyPort: 0,
        proxyListenBind: '0.0.0.0',
        baseAmazonPage: 'amazon.de',
        baseAmazonPageHandle: '_de',
        amazonPageProxyLanguage: 'de_DE',
        acceptLanguage: 'de-DE',
        proxyLogLevel: 'silent',
        formerDataStorePath
    };
    proxyModule.initAmazonProxy(input);

    const refererReq = {
        method: 'POST',
        url: '/ap/cvf/verify',
        headers: {
            host: `127.0.0.1:${ASSIGNED_PORT}`,
            referer: `http://127.0.0.1:${ASSIGNED_PORT}/www.amazon.com/ap/signin`
        }
    };

    const refererTarget = capturedProxyOptions.router(refererReq);

    line('TEST: proxy random port (proxyPort 0)');
    line('');
    line('CODE UNDER TEST:');
    line('- lib/proxy.js: proxyBase() lazy resolution');
    line('- lib/proxy.js: listen callback writes assigned port to _options.proxyPort');
    line('- lib/proxy.js: router()/amazonHostFromProxyUrl()');
    line('');
    line('INPUT:');
    line(`proxyPort: ${input.proxyPort}`);
    line(`assigned listen port: ${ASSIGNED_PORT}`);
    line(`referer header: ${refererReq.headers.referer}`);
    line('');
    line('OBSERVED:');
    line(`_options.proxyPort after init: ${input.proxyPort}`);
    line(`referer router target: ${refererTarget}`);
    line('');
    line('ASSERTIONS:');
    recordAssertion(`_options.proxyPort updated to ${ASSIGNED_PORT}`, () => {
        assert.strictEqual(input.proxyPort, ASSIGNED_PORT);
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
