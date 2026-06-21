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

proxyModule.initAmazonProxy({
    proxyOwnIp: '192.168.0.35',
    proxyPort: 3456,
    proxyListenBind: '0.0.0.0',
    baseAmazonPage: 'amazon.de',
    baseAmazonPageHandle: '_de',
    amazonPageProxyLanguage: 'de_DE',
    acceptLanguage: 'de-DE',
    proxyLogLevel: 'silent',
    formerDataStorePath
}, (_err, data) => {
    callbackData = data;
});

const proxyRes = createProxyResponse('https://www.amazon.de/ap/maplanding?openid.mode=id_res&openid.return_to=https%3A%2F%2Fwww.amazon.de%2Fap%2Fmaplanding');
capturedProxyOptions.onProxyRes(proxyRes, {
    method: 'POST',
    url: '/www.amazon.de/ap/signin',
    originalUrl: '/www.amazon.de/ap/signin'
}, {});

assert.strictEqual(callbackData, undefined);
assert.notStrictEqual(proxyRes.headers.location, 'http://192.168.0.35:3456/cookie-success');
assert.strictEqual(proxyRes.headers.location, 'http://192.168.0.35:3456/www.amazon.de/ap/maplanding?openid.mode=id_res&openid.return_to=https%3A%2F%2Fwww.amazon.de%2Fap%2Fmaplanding');

fs.rmSync(formerDataStorePath, { force: true });
