const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const testName = 'proxy-cookie-rewrite';
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

const proxyModule = loadProxyModule();
const formerDataStorePath = path.join(os.tmpdir(), `alexa-cookie-proxy-cookie-test-${Date.now()}.json`);

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
    const cookieDomainRewrite = capturedProxyOptions.cookieDomainRewrite || {};
    const cookiePathRewrite = capturedProxyOptions.cookiePathRewrite || {};
    const cookieDomainRewriteKeys = Object.keys(cookieDomainRewrite);
    const cookiePathRewriteKeys = Object.keys(cookiePathRewrite);

    line('TEST: proxy cookie rewrite');
    line('');
    line('CODE UNDER TEST:');
    line('- lib/proxy.js: cookieDomainRewrite');
    line('- lib/proxy.js: cookiePathRewrite');
    line('');
    line('INPUT:');
    line(`proxyOwnIp: ${input.proxyOwnIp}`);
    line(`baseAmazonPage: ${input.baseAmazonPage}`);
    line('');
    line('OBSERVED:');
    line(`cookieDomainRewrite keys: ${cookieDomainRewriteKeys.join(', ')}`);
    line(`cookieDomainRewrite["*"]: ${cookieDomainRewrite['*']}`);
    line(`cookiePathRewrite keys: ${cookiePathRewriteKeys.join(', ')}`);
    line(`cookiePathRewrite["*"]: ${cookiePathRewrite['*']}`);
    line(`cookieDomainRewrite contains proxy IP: ${Object.values(cookieDomainRewrite).includes(input.proxyOwnIp)}`);
    line('');
    line('ASSERTIONS:');
    recordAssertion('cookieDomainRewrite only has "*" key', () => {
        assert.deepStrictEqual(cookieDomainRewriteKeys, ['*']);
    });
    recordAssertion('cookieDomainRewrite["*"] === ""', () => {
        assert.strictEqual(cookieDomainRewrite['*'], '');
    });
    recordAssertion('cookieDomainRewrite does not contain proxy IP', () => {
        assert.ok(!Object.values(cookieDomainRewrite).includes(input.proxyOwnIp), 'set-cookie domain must not be rewritten to an IP address');
    });
    recordAssertion('cookiePathRewrite only has "*" key', () => {
        assert.deepStrictEqual(cookiePathRewriteKeys, ['*']);
    });
    recordAssertion('cookiePathRewrite["*"] === "/"', () => {
        assert.strictEqual(cookiePathRewrite['*'], '/');
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
