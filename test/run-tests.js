const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = __dirname;
const outputDir = process.env.ALEXA_COOKIE_TEST_OUTPUT_DIR || path.join(os.tmpdir(), 'alexa-cookie-test-output');
const tests = fs.readdirSync(testDir)
    .filter(name => name.endsWith('.test.js'))
    .sort();

if (!tests.length) {
    console.error('No test files found.');
    process.exit(1);
}

console.log(`Writing test proof output to ${outputDir}`);

for (const test of tests) {
    const testPath = path.join(testDir, test);
    console.log(`\n> ${test}`);

    const result = spawnSync(process.execPath, [testPath], {
        stdio: 'inherit',
        env: {
            ...process.env,
            ALEXA_COOKIE_TEST_OUTPUT_DIR: outputDir
        }
    });

    if (result.error) {
        console.error(`Failed to run ${test}: ${result.error.message}`);
        process.exit(1);
    }

    if (result.signal) {
        console.error(`${test} terminated by signal ${result.signal}`);
        process.exit(1);
    }

    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

console.log(`\n${tests.length} test files passed.`);
