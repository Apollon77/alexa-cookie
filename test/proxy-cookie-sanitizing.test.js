const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const testName = 'proxy-cookie-sanitizing';
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
            return require(name);
        }
    };
    vm.runInNewContext(source, sandbox, { filename: proxyFile });
    return module.exports;
}

function createProxyRequest(cookie) {
    const headers = {
        cookie,
        host: 'www.amazon.de',
        origin: 'https://www.amazon.de'
    };
    return {
        getHeader(name) {
            return headers[name.toLowerCase()];
        },
        setHeader(name, value) {
            headers[name.toLowerCase()] = value;
        },
        getHeaders() {
            return headers;
        }
    };
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
                    method: 'GET',
                    path: '/ap/maplanding?openid.oa2.authorization_code=AUTH_CODE_FROM_PROXY',
                    getHeader() {
                        return undefined;
                    }
                }
            }
        }
    };
}

const proxyModule = loadProxyModule();
const formerDataStorePath = path.join(os.tmpdir(), `alexa-cookie-proxy-cookie-sanitizing-test-${Date.now()}.json`);
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

    const proxyReq = createProxyRequest('connect.sid=LOCAL_BROWSER; session-id=SID_BROWSER; ubid-acbde=UBID_BROWSER');
    const req = {
        method: 'GET',
        url: '/www.amazon.de/ap/maplanding?openid.oa2.authorization_code=AUTH_CODE_FROM_PROXY',
        originalUrl: '/www.amazon.de/ap/maplanding?openid.oa2.authorization_code=AUTH_CODE_FROM_PROXY',
        headers: {
            host: '127.0.0.1:3456'
        },
        on() {}
    };
    capturedProxyOptions.onProxyReq(proxyReq, req);
    capturedProxyOptions.onProxyRes(createProxyResponse('https://www.amazon.de/ap/maplanding?openid.oa2.authorization_code=AUTH_CODE_FROM_PROXY'), req, {});

    line('TEST: proxy callback sanitizes login cookie');
    line('');
    line('CODE UNDER TEST:');
    line('- lib/proxy.js: onProxyReq() proxy cookie capture');
    line('- lib/proxy.js: callbackCookie loginCookie value');
    line('');
    line('OBSERVED:');
    line(`loginCookie: ${callbackData && callbackData.loginCookie}`);
    line('');
    line('ASSERTIONS:');
    recordAssertion('callback data is present', () => {
        assert.ok(callbackData);
    });
    recordAssertion('loginCookie keeps Amazon session-id', () => {
        assert.ok(callbackData.loginCookie.includes('session-id=SID_BROWSER'));
    });
    recordAssertion('loginCookie keeps Amazon ubid cookie', () => {
        assert.ok(callbackData.loginCookie.includes('ubid-acbde=UBID_BROWSER'));
    });
    recordAssertion('loginCookie removes unrelated local browser cookie', () => {
        assert.ok(!callbackData.loginCookie.includes('connect.sid=LOCAL_BROWSER'));
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
