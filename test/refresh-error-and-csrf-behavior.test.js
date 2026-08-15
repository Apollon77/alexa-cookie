const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const EventEmitter = require('events');

const testName = 'refresh-error-and-csrf-behavior';
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

function parseFormBody(body) {
    return Object.fromEntries(new URLSearchParams(body || ''));
}

function headerValue(call, name) {
    const lowerName = name.toLowerCase();
    for (const key of Object.keys(call.headers || {})) {
        if (key.toLowerCase() === lowerName) return call.headers[key];
    }
    return undefined;
}

function assertRefreshTokenRequest(call) {
    assert.strictEqual(call.method, 'POST');
    assert.strictEqual(call.host, 'api.amazon.de');
    assert.strictEqual(headerValue(call, 'Content-Type'), 'application/x-www-form-urlencoded');
    assert.strictEqual(headerValue(call, 'x-amzn-identity-auth-domain'), 'api.amazon.de');

    const body = parseFormBody(call.body);
    assert.strictEqual(body.source_token, 'REFRESH_TOKEN_OLD');
    assert.strictEqual(body.source_token_type, 'refresh_token');
    assert.strictEqual(body.requested_token_type, 'access_token');
    assert.strictEqual(body.package_name, 'com.amazon.echo');
}

function assertExchangeRequest(call) {
    assert.strictEqual(call.method, 'POST');
    assert.strictEqual(call.host, 'www.amazon.de');
    assert.strictEqual(headerValue(call, 'Content-Type'), 'application/x-www-form-urlencoded');
    assert.strictEqual(headerValue(call, 'x-amzn-identity-auth-domain'), 'api.amazon.de');

    const body = parseFormBody(call.body);
    assert.strictEqual(body.domain, '.amazon.de');
    assert.strictEqual(body.source_token, 'REFRESH_TOKEN_OLD');
    assert.strictEqual(body.source_token_type, 'refresh_token');
    assert.strictEqual(body.requested_token_type, 'auth_cookies');
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
                        throw new Error('proxy should not start in refresh behavior tests');
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

function createFakeHttps(responseFor, calls) {
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
                    headers: options.headers || {},
                    body: requestBody,
                    status: null,
                    bodyLength: requestBody.length
                };
                calls.push(call);
                const response = responseFor(options, requestBody);
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

function baseFormerRegistrationData() {
    return {
        loginCookie: 'frc=FRC_OLD; map-md=MAPMD_OLD; session-id=SID_OLD',
        localCookie: 'old-local=OLD',
        refreshToken: 'REFRESH_TOKEN_OLD',
        accessToken: 'ACCESS_TOKEN_OLD',
        macDms: 'MAC_DMS_OLD',
        csrf: 'CSRF_OLD',
        amazonPage: 'amazon.de',
        dataVersion: 2
    };
}

function baseOptions(formerRegistrationData) {
    return {
        baseAmazonPage: 'amazon.de',
        amazonPage: 'amazon.de',
        acceptLanguage: 'de-DE',
        formerRegistrationData,
        logger: () => {}
    };
}

function refreshResult(cookieModule, options) {
    return new Promise((resolve) => {
        cookieModule.refreshAlexaCookie(options, (err, data) => {
            resolve({ err, data });
        });
    });
}

function tokenResponse(body) {
    return {
        statusCode: 200,
        headers: { 'set-cookie': ['session-id=SID_REFRESH; Path=/; Domain=.amazon.de'] },
        body: JSON.stringify(body)
    };
}

function exchangeResponse(cookiesByDomain) {
    return {
        statusCode: 200,
        headers: { 'set-cookie': ['exchange-cookie=EXCHANGE_HEADER; Path=/; Domain=.amazon.de'] },
        body: JSON.stringify({
            response: {
                tokens: {
                    cookies: cookiesByDomain
                }
            }
        })
    };
}

function amazonDeCookies() {
    return {
        '.amazon.de': [
            { Name: 'session-id', Value: 'SID_LOCAL' },
            { Name: 'ubid-acbde', Value: 'UBID_LOCAL' }
        ]
    };
}

async function runMissingAccessTokenScenario() {
    const calls = [];
    const cookieModule = loadCookieModule({
        https: createFakeHttps((options) => {
            if (options.path === '/auth/token') return tokenResponse({});
            throw new Error(`Unexpected request: ${options.method || 'GET'} ${options.host}${options.path}`);
        }, calls)
    });
    const result = await refreshResult(cookieModule, baseOptions(baseFormerRegistrationData()));
    const paths = calls.map((call) => call.path);
    const tokenCall = calls.find((call) => call.path === '/auth/token');

    line('SCENARIO: refresh token response has no access_token');
    line(`observed requests: ${paths.join(', ')}`);
    line(`error message: ${result.err && result.err.message}`);
    line('');
    recordAssertion('missing access_token returns a clear error', () => {
        assert.strictEqual(result.err && result.err.message, 'No new access token in Refresh Token response');
    });
    recordAssertion('missing access_token returns no data', () => {
        assert.strictEqual(result.data, null);
    });
    recordAssertion('missing access_token stops after token request', () => {
        assert.deepStrictEqual(paths, ['/auth/token']);
    });
    recordAssertion('missing access_token request has expected endpoint and form body', () => {
        assertRefreshTokenRequest(tokenCall);
    });
    line('');
}

async function runMissingExchangeDomainScenario() {
    const calls = [];
    const cookieModule = loadCookieModule({
        https: createFakeHttps((options) => {
            if (options.path === '/auth/token') return tokenResponse({ access_token: 'ACCESS_TOKEN_AFTER_REFRESH' });
            if (options.path === '/ap/exchangetoken/cookies') {
                return exchangeResponse({
                    '.amazon.com': [
                        { Name: 'session-id', Value: 'SID_OTHER_DOMAIN' }
                    ]
                });
            }
            throw new Error(`Unexpected request: ${options.method || 'GET'} ${options.host}${options.path}`);
        }, calls)
    });
    const result = await refreshResult(cookieModule, baseOptions(baseFormerRegistrationData()));
    const paths = calls.map((call) => call.path);
    const tokenCall = calls.find((call) => call.path === '/auth/token');
    const exchangeCall = calls.find((call) => call.path === '/ap/exchangetoken/cookies');

    line('SCENARIO: exchange response has cookies for a different domain');
    line(`observed requests: ${paths.join(', ')}`);
    line(`error message: ${result.err && result.err.message}`);
    line('');
    recordAssertion('missing exchange domain returns a clear error', () => {
        assert.strictEqual(result.err && result.err.message, 'No cookies for amazon.de in Exchange response');
    });
    recordAssertion('missing exchange domain returns no data', () => {
        assert.strictEqual(result.data, null);
    });
    recordAssertion('missing exchange domain stops before capabilities and csrf', () => {
        assert.deepStrictEqual(paths, ['/auth/token', '/ap/exchangetoken/cookies']);
    });
    recordAssertion('missing exchange domain refresh request has expected endpoint and form body', () => {
        assertRefreshTokenRequest(tokenCall);
    });
    recordAssertion('missing exchange domain exchange request has expected endpoint and form body', () => {
        assertExchangeRequest(exchangeCall);
    });
    line('');
}

async function runCsrfFallbackScenario() {
    const calls = [];
    const cookieModule = loadCookieModule({
        https: createFakeHttps((options) => {
            if (options.path === '/auth/token') return tokenResponse({ access_token: 'ACCESS_TOKEN_AFTER_REFRESH' });
            if (options.path === '/ap/exchangetoken/cookies') return exchangeResponse(amazonDeCookies());
            if (options.host === 'api.amazonalexa.com' && options.path === '/v1/devices/@self/capabilities') {
                return { statusCode: 204, headers: {}, body: '' };
            }
            if (options.path === '/api/language') return { statusCode: 200, headers: {}, body: '{}' };
            if (options.path === '/spa/index.html') {
                return {
                    statusCode: 200,
                    headers: { 'set-cookie': ['csrf=CSRF_FROM_SPA; Path=/; Domain=.amazon.de'] },
                    body: ''
                };
            }
            throw new Error(`Unexpected request: ${options.method || 'GET'} ${options.host}${options.path}`);
        }, calls)
    });
    const result = await refreshResult(cookieModule, baseOptions(baseFormerRegistrationData()));
    const paths = calls.map((call) => call.path);
    const tokenCall = calls.find((call) => call.path === '/auth/token');
    const exchangeCalls = calls.filter((call) => call.path === '/ap/exchangetoken/cookies');
    const firstCsrfPathIndex = paths.indexOf('/api/language');

    line('SCENARIO: first csrf endpoint has no csrf cookie, second endpoint has one');
    line(`observed requests: ${paths.join(', ')}`);
    line(`result csrf: ${result.data && result.data.csrf}`);
    line('');
    recordAssertion('csrf fallback returns no error', () => {
        assert.strictEqual(result.err, null);
    });
    recordAssertion('csrf fallback tries /api/language before /spa/index.html', () => {
        assert.ok(paths.indexOf('/api/language') !== -1);
        assert.ok(paths.indexOf('/spa/index.html') !== -1);
        assert.ok(paths.indexOf('/api/language') < paths.indexOf('/spa/index.html'));
    });
    recordAssertion('csrf fallback refresh request has expected endpoint and form body', () => {
        assertRefreshTokenRequest(tokenCall);
    });
    recordAssertion('csrf fallback exchanges local cookies before csrf lookup', () => {
        assert.ok(exchangeCalls.length >= 1);
        assert.ok(paths.lastIndexOf('/ap/exchangetoken/cookies') < firstCsrfPathIndex);
    });
    recordAssertion('csrf fallback exchange requests have expected endpoint and form body', () => {
        exchangeCalls.forEach(assertExchangeRequest);
    });
    recordAssertion('csrf fallback uses csrf from second endpoint', () => {
        assert.strictEqual(result.data.csrf, 'CSRF_FROM_SPA');
    });
    recordAssertion('csrf fallback keeps csrf cookie in localCookie', () => {
        assert.ok(result.data.localCookie.includes('csrf=CSRF_FROM_SPA'));
    });
    line('');
}

(async () => {
    try {
        line('TEST: refresh error and csrf behavior');
        line('');
        line('CODE UNDER TEST:');
        line('- alexa-cookie.js: refreshAlexaCookie()');
        line('- alexa-cookie.js: getLocalCookies()');
        line('- alexa-cookie.js: getCSRFFromCookies()');
        line('');
        line('ASSERTIONS:');
        await runMissingAccessTokenScenario();
        await runMissingExchangeDomainScenario();
        await runCsrfFallbackScenario();
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
