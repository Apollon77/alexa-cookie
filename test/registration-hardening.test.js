const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const EventEmitter = require('events');

const testName = 'registration-hardening';
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

const cookieFile = path.join(__dirname, '..', 'alexa-cookie.js');
const source = fs.readFileSync(cookieFile, 'utf8');

function createProxyStub(proxyData) {
    return {
        initAmazonProxy(_options, callbackCookie) {
            callbackCookie(null, Object.assign({
                loginCookie: 'connect.sid=LOCAL_BROWSER; session-id=SID_BROWSER; ubid-acbde=UBID_BROWSER; frc=FRC_PROXY; map-md=MAPMD_PROXY',
                authorization_code: 'AUTH_CODE_FROM_PROXY',
                verifier: 'VERIFIER_FROM_PROXY',
                deviceId: 'DEVICE_ID_FROM_PROXY',
                frc: 'FRC_PROXY',
                'map-md': 'MAPMD_PROXY'
            }, proxyData || {}));
        }
    };
}

function loadCookieModule(overrides = {}) {
    const module = { exports: {} };
    const sandbox = {
        Buffer,
        URL,
        __dirname: path.dirname(cookieFile),
        console,
        module,
        exports: module.exports,
        require(name) {
            if (name === 'https') return overrides.https;
            if (name === './lib/proxy.js') return createProxyStub(overrides.proxyData);
            if (name === 'cookie') return { parse: parseCookies };
            return require(name);
        }
    };
    vm.runInNewContext(source, sandbox, { filename: cookieFile });
    return module.exports;
}

function createFakeHttps(config, calls) {
    function responseFor(options) {
        if (options.path === '/auth/register') {
            return {
                statusCode: 200,
                headers: { 'set-cookie': ['session-id=SID_REGISTER; Path=/; Domain=.amazon.de'] },
                body: JSON.stringify({
                    response: {
                        success: {
                            tokens: {
                                bearer: {
                                    refresh_token: 'REFRESH_TOKEN_AFTER_REGISTER',
                                    access_token: 'ACCESS_TOKEN_AFTER_REGISTER'
                                },
                                mac_dms: {
                                    device_private_key: 'PRIVATE_KEY_AFTER_REGISTER',
                                    adp_token: 'ADP_TOKEN_AFTER_REGISTER'
                                },
                                website_cookies: [
                                    { Name: 'session-token', Value: 'SESSION_TOKEN_AFTER_REGISTER' },
                                    { Name: 'at-acbde', Value: 'AT_AFTER_REGISTER' },
                                    { Name: 'sess-at-acbde', Value: 'SESS_AT_AFTER_REGISTER' }
                                ]
                            }
                        }
                    }
                })
            };
        }
        if (options.host === 'api.amazonalexa.com' && options.path === '/v1/devices/@self/capabilities') {
            return { statusCode: 204, headers: {}, body: '' };
        }
        if (options.path === '/api/users/me?platform=ios&version=2.2.651540.0') {
            if (config.userDataMode === 'empty401') {
                return { statusCode: 401, headers: {}, body: '' };
            }
            return {
                statusCode: 200,
                headers: {},
                body: JSON.stringify({ marketPlaceDomainName: 'www.amazon.de' })
            };
        }
        if (options.path === '/ap/exchangetoken/cookies') {
            if (config.localCookieMode === 'error') {
                return { statusCode: 200, headers: {}, body: '{}' };
            }
            return {
                statusCode: 200,
                headers: { 'set-cookie': ['session-id=SID_LOCAL_HEADER; Path=/; Domain=.amazon.de'] },
                body: JSON.stringify({
                    response: {
                        tokens: {
                            cookies: {
                                '.amazon.de': [
                                    { Name: 'session-id', Value: 'SID_LOCAL' },
                                    { Name: 'ubid-acbde', Value: 'UBID_LOCAL' }
                                ]
                            }
                        }
                    }
                })
            };
        }
        if (options.path === '/api/language') {
            return {
                statusCode: 200,
                headers: { 'set-cookie': ['csrf=CSRF_FROM_API; Path=/; Domain=.amazon.de'] },
                body: '{}'
            };
        }
        throw new Error(`Unexpected request: ${options.method || 'GET'} ${options.host}${options.path}`);
    }

    return {
        request(options, callback) {
            const req = new EventEmitter();
            let requestBody = '';
            req.write = (chunk) => {
                requestBody += chunk;
            };
            req.end = () => {
                const call = {
                    method: options.method || 'GET',
                    host: options.host,
                    path: options.path,
                    headers: Object.assign({}, options.headers),
                    requestBody,
                    status: null
                };
                calls.push(call);
                const response = responseFor(options);
                call.status = response.statusCode;
                const res = new EventEmitter();
                res.statusCode = response.statusCode;
                res.headers = response.headers || {};
                res.socket = { end() {} };
                callback(res);
                if (response.body) res.emit('data', Buffer.from(response.body));
                res.emit('end');
            };
            return req;
        }
    };
}

function runScenario(config = {}) {
    const calls = [];
    const callbacks = [];
    const cookieModule = loadCookieModule({
        https: createFakeHttps(config, calls),
        proxyData: config.proxyData
    });

    cookieModule.generateAlexaCookie({
        proxyOwnIp: '127.0.0.1',
        proxyPort: 3456,
        proxyListenBind: '0.0.0.0',
        baseAmazonPage: 'amazon.de',
        amazonPage: 'amazon.de',
        acceptLanguage: 'de-DE',
        proxyLogLevel: 'silent',
        logger: () => {}
    }, (err, data) => {
        callbacks.push({ err, data });
    });

    return { calls, callbacks };
}

try {
    line('TEST: registration hardening');
    line('');
    line('CODE UNDER TEST:');
    line('- alexa-cookie.js: handleTokenRegistration()');
    line('- alexa-cookie.js: optional /api/users/me handling');
    line('- alexa-cookie.js: getLocalCookies() error path after registration');
    line('');

    const sanitizedScenario = runScenario();
    const registerCall = sanitizedScenario.calls.find((call) => call.path === '/auth/register');
    const registerBody = JSON.parse(registerCall.requestBody);

    line('ASSERTIONS:');
    recordAssertion('registration Cookie header removes unrelated local browser cookie', () => {
        assert.ok(!registerCall.headers.Cookie.includes('connect.sid=LOCAL_BROWSER'));
    });
    recordAssertion('registration body removes unrelated local browser cookie', () => {
        assert.ok(!registerBody.cookies.website_cookies.some((cookie) => cookie.Name === 'connect.sid'));
    });
    recordAssertion('registration body keeps Amazon session cookie', () => {
        assert.ok(registerBody.cookies.website_cookies.some((cookie) => cookie.Name === 'session-id' && cookie.Value === 'SID_BROWSER'));
    });

    const emptyUserDataScenario = runScenario({ userDataMode: 'empty401' });
    recordAssertion('empty optional user-data response continues when amazonPage is known', () => {
        assert.strictEqual(emptyUserDataScenario.callbacks.length, 1);
        assert.ifError(emptyUserDataScenario.callbacks[0].err);
        assert.strictEqual(emptyUserDataScenario.callbacks[0].data.amazonPage, 'amazon.de');
        assert.ok(emptyUserDataScenario.callbacks[0].data.localCookie.includes('session-id=SID_LOCAL'));
    });

    const localCookieErrorScenario = runScenario({ localCookieMode: 'error' });
    recordAssertion('local-cookie retrieval error stops registration callback flow', () => {
        assert.strictEqual(localCookieErrorScenario.callbacks.length, 1);
        assert.ok(localCookieErrorScenario.callbacks[0].err);
        assert.match(localCookieErrorScenario.callbacks[0].err.message, /No cookies in Exchange response/);
        assert.strictEqual(localCookieErrorScenario.calls.filter((call) => call.path === '/api/language').length, 0);
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
