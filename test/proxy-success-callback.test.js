const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const testName = 'proxy-success-callback';
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

function parseCookies(cookieHeader) {
    const result = {};
    for (const part of String(cookieHeader || '').split(';')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const idx = trimmed.indexOf('=');
        if (idx === -1) continue;
        result[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
    return result;
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
            if (name === 'cookie') return { parse: parseCookies };
            return require(name);
        }
    };
    vm.runInNewContext(source, sandbox, { filename: proxyFile });
    return module.exports;
}

function createProxyResponse(location) {
    return {
        statusCode: 200,
        headers: {
            location,
            'set-cookie': ['session-id=SID_PROXY; Path=/; Domain=.amazon.de; Secure']
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

function createProxyRequest(initialHeaders = {}) {
    const headers = {};
    for (const name of Object.keys(initialHeaders)) {
        headers[name.toLowerCase()] = initialHeaders[name];
    }

    return {
        getHeader(name) {
            return headers[name.toLowerCase()];
        },
        setHeader(name, value) {
            headers[name.toLowerCase()] = value;
        },
        getHeaders() {
            return { ...headers };
        }
    };
}

const proxyModule = loadProxyModule();
const formerDataStorePath = path.join(os.tmpdir(), `alexa-cookie-proxy-callback-test-${Date.now()}.json`);
let callbackErr;
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
        formerDataStorePath,
        formerRegistrationData: {
            frc: 'FRC_FROM_FORMER_DATA',
            'map-md': 'MAPMD_FROM_FORMER_DATA'
        }
    };
    proxyModule.initAmazonProxy(input, (err, data) => {
        callbackErr = err;
        callbackData = data;
    });

    const responseLocation = 'https://www.amazon.de/ap/maplanding?openid.mode=id_res&openid.oa2.authorization_code=AUTH%20CODE%2FVALUE';
    const proxyRes = createProxyResponse(responseLocation);
    const req = {
        method: 'POST',
        url: '/www.amazon.de/ap/signin',
        originalUrl: '/www.amazon.de/ap/signin',
        on() {}
    };
    const proxyReq = createProxyRequest({
        host: 'www.amazon.de'
    });

    capturedProxyOptions.onProxyReq(proxyReq, req, {});
    capturedProxyOptions.onProxyRes(proxyRes, req, {});
    const proxyRequestCookies = parseCookies(proxyReq.getHeader('cookie'));
    const callbackCookies = parseCookies(callbackData && callbackData.loginCookie);

    line('TEST: proxy success callback');
    line('');
    line('CODE UNDER TEST:');
    line('- lib/proxy.js: onProxyReq()');
    line('- lib/proxy.js: onProxyRes()');
    line('- lib/proxy.js: maplanding success callback');
    line('');
    line('INPUT:');
    line(`response location: ${responseLocation}`);
    line(`request method: ${req.method}`);
    line(`request originalUrl: ${req.originalUrl}`);
    line('');
    line('OBSERVED:');
    line(`callback error present: ${Boolean(callbackErr)}`);
    line(`callback data present: ${callbackData !== undefined}`);
    line(`final response location: ${proxyRes.headers.location}`);
    line(`final status: ${proxyRes.statusCode}`);
    line(`proxy request cookie: ${proxyReq.getHeader('cookie')}`);
    line(`callback loginCookie names: ${Object.keys(callbackCookies).join(', ')}`);
    line('');
    line('ASSERTIONS:');
    recordAssertion('callback has no error', () => {
        assert.strictEqual(callbackErr, null);
    });
    recordAssertion('callback data is present', () => {
        assert.ok(callbackData);
    });
    recordAssertion('successful maplanding redirects to local cookie success page', () => {
        assert.strictEqual(proxyRes.headers.location, 'http://127.0.0.1:3456/cookie-success');
    });
    recordAssertion('successful maplanding keeps redirect status', () => {
        assert.strictEqual(proxyRes.statusCode, 302);
    });
    recordAssertion('callback contains decoded authorization code', () => {
        assert.strictEqual(callbackData.authorization_code, 'AUTH CODE/VALUE');
    });
    recordAssertion('callback contains collected proxy cookie', () => {
        assert.strictEqual(callbackCookies['session-id'], 'SID_PROXY');
    });
    recordAssertion('proxy request includes frc from former data', () => {
        assert.strictEqual(proxyRequestCookies.frc, 'FRC_FROM_FORMER_DATA');
    });
    recordAssertion('proxy request includes map-md from former data', () => {
        assert.strictEqual(proxyRequestCookies['map-md'], 'MAPMD_FROM_FORMER_DATA');
    });
    recordAssertion('callback loginCookie includes frc for later token exchange', () => {
        assert.strictEqual(callbackCookies.frc, 'FRC_FROM_FORMER_DATA');
    });
    recordAssertion('callback loginCookie includes map-md for later token exchange', () => {
        assert.strictEqual(callbackCookies['map-md'], 'MAPMD_FROM_FORMER_DATA');
    });
    recordAssertion('callback reuses frc from former data', () => {
        assert.strictEqual(callbackData.frc, input.formerRegistrationData.frc);
    });
    recordAssertion('callback reuses map-md from former data', () => {
        assert.strictEqual(callbackData['map-md'], input.formerRegistrationData['map-md']);
    });
    recordAssertion('callback contains deviceId for later token exchange', () => {
        assert.strictEqual(typeof callbackData.deviceId, 'string');
        assert.ok(callbackData.deviceId.length > 20);
    });
    recordAssertion('callback contains verifier for later token exchange', () => {
        assert.strictEqual(typeof callbackData.verifier, 'string');
        assert.ok(callbackData.verifier.length > 20);
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
