const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const EventEmitter = require('events');

const testName = 'refresh-skips-app-registration';
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
            if (name === 'https' && overrides.https) return overrides.https;
            if (name === './lib/proxy.js') {
                return {
                    initAmazonProxy() {
                        throw new Error('proxy should not start in this test');
                    }
                };
            }
            if (name === 'cookie') return { parse: parseCookies };
            return require(name);
        }
    };
    vm.runInNewContext(source, sandbox, { filename: cookieFile });
    return module.exports;
}

function createFakeHttps(calls) {
    function responseFor(options) {
        if (options.path === '/auth/token') {
            return {
                statusCode: 200,
                headers: { 'set-cookie': ['session-id=SID_REFRESH; Path=/; Domain=.amazon.de'] },
                body: JSON.stringify({ access_token: 'ACCESS_TOKEN_AFTER_REFRESH' })
            };
        }
        if (options.host === 'api.amazonalexa.com' && options.path === '/v1/devices/@self/capabilities') {
            return { statusCode: 204, headers: {}, body: '' };
        }
        if (options.path === '/ap/exchangetoken/cookies') {
            return {
                statusCode: 200,
                headers: { 'set-cookie': ['exchange-cookie=EXCHANGE_HEADER; Path=/; Domain=.amazon.de'] },
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
                calls.push({
                    method: options.method || 'GET',
                    host: options.host,
                    path: options.path,
                    status: null,
                    hasAuthorization: Boolean(options.headers && options.headers.authorization),
                    bodyLength: requestBody.length
                });
                const response = responseFor(options);
                calls[calls.length - 1].status = response.statusCode;
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

function refresh(cookieModule, options) {
    return new Promise((resolve, reject) => {
        cookieModule.refreshAlexaCookie(options, (err, data) => {
            if (err) reject(err);
            else resolve(data);
        });
    });
}

(async () => {
    const calls = [];
    const cookieModule = loadCookieModule({ https: createFakeHttps(calls) });
    const formerRegistrationData = {
        loginCookie: 'frc=FRC_OLD; map-md=MAPMD_OLD; session-id=SID_OLD',
        localCookie: 'old-local=OLD',
        refreshToken: 'REFRESH_TOKEN_OLD',
        accessToken: 'ACCESS_TOKEN_OLD',
        macDms: 'MAC_DMS_OLD',
        csrf: 'CSRF_OLD',
        amazonPage: 'amazon.de',
        authorization_code: 'AUTH_CODE_FROM_LOGIN',
        verifier: 'VERIFIER_FROM_LOGIN',
        dataVersion: 2
    };

    try {
        const result = await refresh(cookieModule, {
            baseAmazonPage: 'amazon.de',
            amazonPage: 'amazon.de',
            acceptLanguage: 'de-DE',
            formerRegistrationData,
            logger: () => {}
        });

        const paths = calls.map((call) => call.path);
        const capabilityCall = calls.find((call) => call.path === '/v1/devices/@self/capabilities');

        line('TEST: refresh skips app registration');
        line('');
        line('CODE UNDER TEST:');
        line('- alexa-cookie.js: refreshAlexaCookie()');
        line('- alexa-cookie.js: registerTokenCapabilities()');
        line('- alexa-cookie.js: getLocalCookies()');
        line('');
        line('INPUT:');
        line('baseAmazonPage: amazon.de');
        line('amazonPage: amazon.de');
        line(`formerRegistrationData has refreshToken: ${Boolean(formerRegistrationData.refreshToken)}`);
        line(`formerRegistrationData has accessToken: ${Boolean(formerRegistrationData.accessToken)}`);
        line(`formerRegistrationData has authorization_code: ${Object.prototype.hasOwnProperty.call(formerRegistrationData, 'authorization_code')}`);
        line(`formerRegistrationData has verifier: ${Object.prototype.hasOwnProperty.call(formerRegistrationData, 'verifier')}`);
        line('');
        line('OBSERVED REQUESTS:');
        calls.forEach((call) => {
            line(`- ${call.method} ${call.host}${call.path} -> ${call.status}`);
        });
        line('');
        line('OBSERVED RESULT:');
        line(`result amazonPage: ${result.amazonPage}`);
        line(`result has accessToken: ${Boolean(result.accessToken)}`);
        line(`result has refreshToken: ${Boolean(result.refreshToken)}`);
        line(`result has macDms: ${Boolean(result.macDms)}`);
        line(`result has csrf: ${Boolean(result.csrf)}`);
        line(`result has authorization_code: ${Object.prototype.hasOwnProperty.call(result, 'authorization_code')}`);
        line(`result has verifier: ${Object.prototype.hasOwnProperty.call(result, 'verifier')}`);
        line(`result loginCookie includes exchange-cookie: ${result.loginCookie.includes('exchange-cookie=EXCHANGE_HEADER')}`);
        line(`result localCookie includes refreshed session-id: ${result.localCookie.includes('session-id=SID_LOCAL')}`);
        line('');
        line('ASSERTIONS:');
        recordAssertion('requests include /auth/token', () => {
            assert.ok(paths.includes('/auth/token'));
        });
        recordAssertion('requests include /v1/devices/@self/capabilities', () => {
            assert.ok(paths.includes('/v1/devices/@self/capabilities'));
        });
        recordAssertion('requests include /ap/exchangetoken/cookies', () => {
            assert.ok(paths.includes('/ap/exchangetoken/cookies'));
        });
        recordAssertion('requests include /api/language', () => {
            assert.ok(paths.includes('/api/language'));
        });
        recordAssertion('requests do not include /auth/register', () => {
            assert.ok(!paths.includes('/auth/register'));
        });
        recordAssertion('capability request uses PUT api.amazonalexa.com', () => {
            assert.strictEqual(capabilityCall.host, 'api.amazonalexa.com');
            assert.strictEqual(capabilityCall.method, 'PUT');
        });
        recordAssertion('capability request has authorization header', () => {
            assert.strictEqual(capabilityCall.hasAuthorization, true);
        });
        recordAssertion('result accessToken was refreshed', () => {
            assert.strictEqual(result.accessToken, 'ACCESS_TOKEN_AFTER_REFRESH');
        });
        recordAssertion('result refreshToken preserved', () => {
            assert.strictEqual(result.refreshToken, 'REFRESH_TOKEN_OLD');
        });
        recordAssertion('result macDms preserved', () => {
            assert.strictEqual(result.macDms, 'MAC_DMS_OLD');
        });
        recordAssertion('result csrf refreshed from API cookie', () => {
            assert.strictEqual(result.csrf, 'CSRF_FROM_API');
        });
        recordAssertion('result localCookie contains exchanged session-id', () => {
            assert.ok(result.localCookie.includes('session-id=SID_LOCAL'));
        });
        recordAssertion('result loginCookie excludes non-Amazon exchange response cookie', () => {
            assert.ok(!result.loginCookie.includes('exchange-cookie=EXCHANGE_HEADER'));
        });
        recordAssertion('result does not keep authorization_code', () => {
            assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'authorization_code'), false);
        });
        recordAssertion('result does not keep verifier', () => {
            assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'verifier'), false);
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
})();
