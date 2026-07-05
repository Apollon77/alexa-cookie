const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const testName = 'proxy-success-requires-auth-code';
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

function createProxyResponse(location) {
    return {
        statusCode: 302,
        headers: {
            location
        },
        socket: {
            _host: 'www.amazon.de',
            parser: {
                outgoing: {
                    method: 'POST',
                    path: '/ap/signin',
                    getHeader() {
                        return undefined;
                    }
                }
            }
        }
    };
}

const proxyModule = loadProxyModule();
const formerDataStorePath = path.join(os.tmpdir(), `alexa-cookie-proxy-success-test-${Date.now()}.json`);
let callbackData;

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
    proxyModule.initAmazonProxy(input, (_err, data) => {
        callbackData = data;
    });

    const responseLocation = 'https://www.amazon.de/ap/maplanding?openid.mode=id_res&openid.return_to=https%3A%2F%2Fwww.amazon.de%2Fap%2Fmaplanding';
    const proxyRes = createProxyResponse(responseLocation);
    const req = {
        method: 'POST',
        url: '/www.amazon.de/ap/signin',
        originalUrl: '/www.amazon.de/ap/signin'
    };

    capturedProxyOptions.onProxyRes(proxyRes, req, {});

    line('TEST: proxy success requires auth code');
    line('');
    line('CODE UNDER TEST:');
    line('- lib/proxy.js: onProxyRes()');
    line('- lib/proxy.js: maplanding success detection');
    line('');
    line('INPUT:');
    line(`response location: ${responseLocation}`);
    line(`request method: ${req.method}`);
    line(`request originalUrl: ${req.originalUrl}`);
    line('');
    line('OBSERVED:');
    line(`callback data present: ${callbackData !== undefined}`);
    line(`final response location: ${proxyRes.headers.location}`);
    line('');
    line('ASSERTIONS:');
    recordAssertion('callbackData === undefined', () => {
        assert.strictEqual(callbackData === undefined, true);
    });
    recordAssertion('final location !== local /cookie-success', () => {
        assert.notStrictEqual(proxyRes.headers.location, 'http://127.0.0.1:3456/cookie-success');
    });
    recordAssertion('final location preserves proxied maplanding path', () => {
        assert.strictEqual(proxyRes.headers.location, 'http://127.0.0.1:3456/www.amazon.de/ap/maplanding?openid.mode=id_res&openid.return_to=https%3A%2F%2Fwww.amazon.de%2Fap%2Fmaplanding');
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
