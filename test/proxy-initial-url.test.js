const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const testName = 'proxy-initial-url';
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
const formerDataStorePath = path.join(os.tmpdir(), `alexa-cookie-proxy-test-${Date.now()}.json`);

try {
    const input = {
        proxyOwnIp: '127.0.0.1',
        proxyPort: 3456,
        proxyListenBind: '0.0.0.0',
        baseAmazonPage: 'amazon.co.uk',
        baseAmazonPageHandle: '_uk',
        amazonPageProxyLanguage: 'en_GB',
        acceptLanguage: 'en-GB',
        proxyLogLevel: 'silent',
        formerDataStorePath
    };
    proxyModule.initAmazonProxy(input);

    const req = {
        method: 'GET',
        url: '/',
        headers: {
            host: '127.0.0.1:3456'
        }
    };

    const target = capturedProxyOptions.router(req);
    const rewrittenPath = applyPathRewrite(req.url, req);
    const targetUrl = new URL(target);
    const rewrittenUrl = new URL(rewrittenPath, target);

    line('TEST: proxy initial URL');
    line('');
    line('CODE UNDER TEST:');
    line('- lib/proxy.js: router()');
    line('- lib/proxy.js: pathRewrite / rewriteProxyPath()');
    line('- lib/proxy.js: buildInitialUrl()');
    line('');
    line('INPUT:');
    line(`baseAmazonPage: ${input.baseAmazonPage}`);
    line(`baseAmazonPageHandle: ${input.baseAmazonPageHandle}`);
    line(`proxy host header: ${req.headers.host}`);
    line(`request url: ${req.url}`);
    line('');
    line('OBSERVED:');
    line(`router target host: ${targetUrl.host}`);
    line(`router target search: ${targetUrl.search}`);
    line(`rewritten pathname: ${rewrittenUrl.pathname}`);
    line(`rewritten openid.assoc_handle: ${rewrittenUrl.searchParams.get('openid.assoc_handle')}`);
    line(`rewritten pageId: ${rewrittenUrl.searchParams.get('pageId')}`);
    line(`rewritten openid.return_to: ${rewrittenUrl.searchParams.get('openid.return_to')}`);
    line(`rewritten openid.ns.oa2: ${rewrittenUrl.searchParams.get('openid.ns.oa2')}`);
    line(`rewritten path starts with /ap/signin?: ${rewrittenPath.startsWith('/ap/signin?')}`);
    line(`rewritten path contains openid.return_to: ${rewrittenPath.includes('openid.return_to=')}`);
    line(`rewritten path contains regional handle: ${rewrittenPath.includes('amzn_dp_project_dee_ios_uk')}`);
    line(`rewritten path contains code challenge: ${rewrittenPath.includes('openid.oa2.code_challenge=')}`);
    line('');
    line('ASSERTIONS:');
    recordAssertion('router target host === "www.amazon.co.uk"', () => {
        assert.strictEqual(targetUrl.host, 'www.amazon.co.uk');
    });
    recordAssertion('router target search === ""', () => {
        assert.ok(targetUrl.search === '', 'router target search must be empty');
    });
    recordAssertion('rewritten path starts with "/ap/signin?"', () => {
        assert.ok(rewrittenPath.startsWith('/ap/signin?'), `expected signin path, got ${rewrittenPath}`);
    });
    recordAssertion('rewritten assoc handle === "amzn_dp_project_dee_ios_uk"', () => {
        assert.strictEqual(rewrittenUrl.searchParams.get('openid.assoc_handle'), 'amzn_dp_project_dee_ios_uk');
    });
    recordAssertion('rewritten pageId === "amzn_dp_project_dee_ios_uk"', () => {
        assert.strictEqual(rewrittenUrl.searchParams.get('pageId'), 'amzn_dp_project_dee_ios_uk');
    });
    recordAssertion('rewritten path contains "openid.return_to="', () => {
        assert.ok(rewrittenPath.includes('openid.return_to='));
    });
    recordAssertion('rewritten path contains regional "_uk" handle', () => {
        assert.ok(rewrittenPath.includes('amzn_dp_project_dee_ios_uk'));
    });
    recordAssertion('rewritten path contains "openid.oa2.code_challenge="', () => {
        assert.ok(rewrittenPath.includes('openid.oa2.code_challenge='));
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
