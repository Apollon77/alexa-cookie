const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

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

proxyModule.initAmazonProxy({
    proxyOwnIp: '192.168.0.35',
    proxyPort: 3456,
    proxyListenBind: '0.0.0.0',
    baseAmazonPage: 'amazon.de',
    baseAmazonPageHandle: '',
    amazonPageProxyLanguage: 'de_DE',
    acceptLanguage: 'de-DE',
    proxyLogLevel: 'silent',
    formerDataStorePath
});

const req = {
    method: 'GET',
    url: '/',
    headers: {
        host: '192.168.0.35:3456'
    }
};

const target = capturedProxyOptions.router(req);
const rewrittenPath = applyPathRewrite(req.url, req);

assert.strictEqual(new URL(target).host, 'www.amazon.de');
assert.ok(rewrittenPath.startsWith('/ap/signin?'), `expected signin path, got ${rewrittenPath}`);
assert.ok(rewrittenPath.includes('openid.return_to='));
assert.ok(rewrittenPath.includes('openid.oa2.code_challenge='));

fs.rmSync(formerDataStorePath, { force: true });
