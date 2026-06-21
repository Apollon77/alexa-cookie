const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const cookieFile = path.join(__dirname, '..', 'alexa-cookie.js');
const source = fs.readFileSync(cookieFile, 'utf8');

let capturedProxyOptions;

function loadCookieModule() {
    capturedProxyOptions = undefined;
    const module = { exports: {} };
    const sandbox = {
        __dirname: path.dirname(cookieFile),
        console,
        module,
        exports: module.exports,
        require(name) {
            if (name === './lib/proxy.js') {
                return {
                    initAmazonProxy(options, _callbackCookie, callbackListening) {
                        capturedProxyOptions = options;
                        callbackListening && callbackListening({
                            address: () => ({ port: options.proxyPort || 3456 }),
                            close: (callback) => callback && callback()
                        });
                    }
                };
            }
            if (name === 'cookie') {
                return { parse: () => ({}) };
            }
            return require(name);
        }
    };
    vm.runInNewContext(source, sandbox, { filename: cookieFile });
    return module.exports;
}

function runProxyOnlyConfig(baseAmazonPage) {
    const cookieModule = loadCookieModule();
    cookieModule.generateAlexaCookie('', '', {
        proxyOwnIp: '192.168.0.35',
        proxyPort: 3456,
        baseAmazonPage,
        amazonPage: baseAmazonPage,
        logger: () => {}
    }, () => {});
    return capturedProxyOptions;
}

const deOptions = runProxyOnlyConfig('amazon.de');
assert.strictEqual(deOptions.baseAmazonPageHandle, '_de');

const comOptions = runProxyOnlyConfig('amazon.com');
assert.strictEqual(comOptions.baseAmazonPageHandle, '');
