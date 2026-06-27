const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const testName = 'base-amazon-page-handle';
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
    const input = {
        proxyOwnIp: '127.0.0.1',
        proxyPort: 3456,
        baseAmazonPage,
        amazonPage: baseAmazonPage,
        logger: () => {}
    };
    cookieModule.generateAlexaCookie('', '', input, () => {});
    return { input, output: capturedProxyOptions };
}

try {
    const de = runProxyOnlyConfig('amazon.de');
    const uk = runProxyOnlyConfig('amazon.co.uk');
    const com = runProxyOnlyConfig('amazon.com');

    line('TEST: base Amazon page handle');
    line('');
    line('CODE UNDER TEST:');
    line('- alexa-cookie.js: generateAlexaCookie option initialization');
    line('- option passed to lib/proxy.js: baseAmazonPageHandle');
    line('');
    line('INPUT:');
    line(`DE baseAmazonPage: ${de.input.baseAmazonPage}`);
    line(`DE amazonPage: ${de.input.amazonPage}`);
    line(`UK baseAmazonPage: ${uk.input.baseAmazonPage}`);
    line(`UK amazonPage: ${uk.input.amazonPage}`);
    line(`COM baseAmazonPage: ${com.input.baseAmazonPage}`);
    line(`COM amazonPage: ${com.input.amazonPage}`);
    line('');
    line('OBSERVED:');
    line(`DE baseAmazonPageHandle: ${de.output.baseAmazonPageHandle}`);
    line(`UK baseAmazonPageHandle: ${uk.output.baseAmazonPageHandle}`);
    line(`COM baseAmazonPageHandle: ${com.output.baseAmazonPageHandle}`);
    line('');
    line('ASSERTIONS:');
    recordAssertion('DE baseAmazonPageHandle === "_de"', () => {
        assert.strictEqual(de.output.baseAmazonPageHandle, '_de');
    });
    recordAssertion('UK baseAmazonPageHandle === "_uk"', () => {
        assert.strictEqual(uk.output.baseAmazonPageHandle, '_uk');
    });
    recordAssertion('COM baseAmazonPageHandle === ""', () => {
        assert.strictEqual(com.output.baseAmazonPageHandle, '');
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
