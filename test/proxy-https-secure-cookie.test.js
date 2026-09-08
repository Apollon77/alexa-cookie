const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const testName = 'proxy-https-secure-cookie';
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
            'set-cookie': ['session-id=SID_PROXY; Path=/; Domain=.amazon.de; Secure; SameSite=None']
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

function runScenario(proxyHttps) {
    const proxyModule = loadProxyModule();
    const formerDataStorePath = path.join(os.tmpdir(), `alexa-cookie-proxy-https-test-${proxyHttps}-${Date.now()}.json`);
    let callbackData;

    try {
        const input = {
            proxyOwnIp: '127.0.0.1',
            proxyPort: 3456,
            proxyListenBind: '0.0.0.0',
            proxyHttps,
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

        const responseLocation = 'https://www.amazon.de/ap/maplanding?openid.mode=id_res&openid.oa2.authorization_code=AUTH_CODE';
        const proxyRes = createProxyResponse(responseLocation);
        const req = {
            method: 'POST',
            url: '/www.amazon.de/ap/signin',
            originalUrl: '/www.amazon.de/ap/signin',
            on() {}
        };
        const proxyReq = createProxyRequest({ host: 'www.amazon.de' });

        capturedProxyOptions.onProxyReq(proxyReq, req, {});
        capturedProxyOptions.onProxyRes(proxyRes, req, {});

        return { callbackData, proxyRes };
    } finally {
        fs.rmSync(formerDataStorePath, { force: true });
    }
}

try {
    const httpResult = runScenario(false);
    const httpsResult = runScenario(true);

    line('TEST: proxyHttps controls the Secure cookie flag and redirect scheme');
    line('');
    line('CODE UNDER TEST:');
    line('- lib/proxy.js: proxyScheme()/proxyBase()');
    line('- lib/proxy.js: onProxyRes() Secure-flag stripping');
    line('');
    line('OBSERVED:');
    line(`proxyHttps=false redirect location: ${httpResult.proxyRes.headers.location}`);
    line(`proxyHttps=false set-cookie: ${httpResult.proxyRes.headers['set-cookie'][0]}`);
    line(`proxyHttps=true redirect location: ${httpsResult.proxyRes.headers.location}`);
    line(`proxyHttps=true set-cookie: ${httpsResult.proxyRes.headers['set-cookie'][0]}`);
    line('');
    line('ASSERTIONS:');
    recordAssertion('default (proxyHttps unset) redirects with http scheme, unchanged behaviour', () => {
        assert.strictEqual(httpResult.proxyRes.headers.location, 'http://127.0.0.1:3456/cookie-success');
    });
    recordAssertion('default (proxyHttps unset) strips Secure so cookie reaches a plain-http browser', () => {
        assert.ok(!httpResult.proxyRes.headers['set-cookie'][0].includes('Secure'));
    });
    recordAssertion('proxyHttps=true redirects with https scheme', () => {
        assert.strictEqual(httpsResult.proxyRes.headers.location, 'https://127.0.0.1:3456/cookie-success');
    });
    recordAssertion('proxyHttps=true preserves Secure so SameSite=None cookies are accepted by the browser', () => {
        assert.ok(httpsResult.proxyRes.headers['set-cookie'][0].includes('Secure'));
    });
    recordAssertion('proxyHttps=true does not otherwise change the cookie value', () => {
        assert.strictEqual(
            httpsResult.proxyRes.headers['set-cookie'][0],
            'session-id=SID_PROXY; Path=/; Domain=.amazon.de; Secure; SameSite=None'
        );
    });
    recordAssertion('both scenarios still capture the proxied cookie in the callback', () => {
        assert.ok(parseCookies(httpResult.callbackData.loginCookie)['session-id']);
        assert.ok(parseCookies(httpsResult.callbackData.loginCookie)['session-id']);
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
}
