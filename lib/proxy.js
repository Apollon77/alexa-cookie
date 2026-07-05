/* jshint -W097 */
/* jshint -W030 */
/* jshint strict: false */
/* jslint node: true */
/* jslint esversion: 6 */
'use strict';

const modifyResponse = require('http-proxy-response-rewrite');
const express = require('express');
const proxy = require('http-proxy-middleware').createProxyMiddleware;
const querystring = require('querystring');
const cookieTools = require('cookie');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMERDATA_STORE_VERSION = 4;
const ALEXA_APP_VERSION = '2.2.651540.0';
const EXTRA_AMAZON_PROXY_HOSTS = ['amazon.com', 'www.amazon.com', 'alexa.amazon.com'];

function addCookies(Cookie, headers) {
    if (!headers || !headers['set-cookie']) return Cookie;
    const cookies = cookieTools.parse(Cookie);
    for (let cookie of headers['set-cookie']) {
        cookie = cookie.match(/^([^=]+)=([^;]+);.*/);
        if (cookie && cookie.length === 3) {
            if (cookie[1] === 'ap-fid' && cookie[2] === '""') continue;
            cookies[cookie[1]] = cookie[2];
        }
    }
    Cookie = '';
    for (const name of Object.keys(cookies)) {
        Cookie += `${name}=${cookies[name]}; `;
    }
    Cookie = Cookie.replace(/[; ]*$/, '');
    return Cookie;
}

function isAmazonCookieName(name) {
    return /^(session-id|session-id-time|session-token|ubid-.+|lc-.+|x-.+|at-.+|sess-at-.+|frc|map-md|csrf|sid|csm-hit|i18n-prefs|sp-cdn|skin)$/.test(name);
}

function sanitizeAmazonCookie(cookie) {
    const cookies = cookieTools.parse(cookie || '');
    let sanitizedCookie = '';
    for (const name of Object.keys(cookies)) {
        if (isAmazonCookieName(name)) {
            sanitizedCookie += `${name}=${cookies[name]}; `;
        }
    }
    return sanitizedCookie.replace(/[; ]*$/, '');
}

function customStringify(v, func, intent) {
    const cache = new Map();
    return JSON.stringify(v, function (key, value) {
        if (typeof value === 'object' && value !== null) {
            if (cache.get(value)) {
                // Circular reference found, discard key
                return;
            }
            // Store value in our map
            cache.set(value, true);
        }
        if (Buffer.isBuffer(value)) {
            // Buffers not relevant to be logged, ignore
            return;
        }
        return value;
    }, intent);
}

function initAmazonProxy(_options, callbackCookie, callbackListening) {
    const initialCookies = {};
    const proxyBase = `http://${_options.proxyOwnIp}:${_options.proxyPort}/`;
    const defaultAmazonHost = `www.${_options.baseAmazonPage}`;
    const amazonProxyHosts = [];

    function escapeRegex(data) {
        return data.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function addAmazonProxyHost(host) {
        if (host && !amazonProxyHosts.includes(host)) {
            amazonProxyHosts.push(host);
        }
    }

    function amazonRootFromHost(host) {
        return host.replace(/^(www|alexa)\./, '');
    }

    addAmazonProxyHost(defaultAmazonHost);
    addAmazonProxyHost(`alexa.${_options.baseAmazonPage}`);
    addAmazonProxyHost(_options.baseAmazonPage);
    EXTRA_AMAZON_PROXY_HOSTS.forEach(addAmazonProxyHost);

    function amazonHostFromProxyPath(url) {
        const match = (url || '').match(/^\/([^/?#]+)(?:[/?#]|$)/);
        if (match && amazonProxyHosts.includes(match[1])) {
            return match[1];
        }
        return null;
    }

    function amazonHostFromProxyUrl(url) {
        if (!url) return null;
        for (const host of amazonProxyHosts) {
            if (url === `${proxyBase}${host}` || url.startsWith(`${proxyBase}${host}/`)) {
                return host;
            }
        }
        return null;
    }

    const formerDataStorePath = _options.formerDataStorePath || path.join(__dirname, 'formerDataStore.json');
    let formerDataStoreValid = false;
    if (!_options.formerRegistrationData) {
        try {
            if (fs.existsSync(formerDataStorePath)) {
                const formerDataStore = JSON.parse(fs.readFileSync(path.join(__dirname, 'formerDataStore.json'), 'utf8'));
                if (typeof formerDataStore === 'object' && formerDataStore.storeVersion === FORMERDATA_STORE_VERSION) {
                    _options.formerRegistrationData = _options.formerRegistrationData || {};
                    _options.formerRegistrationData.frc = _options.formerRegistrationData.frc || formerDataStore.frc;
                    _options.formerRegistrationData['map-md'] = _options.formerRegistrationData['map-md'] || formerDataStore['map-md'];
                    _options.formerRegistrationData.deviceId = _options.formerRegistrationData.deviceId || formerDataStore.deviceId;
                    _options.logger && _options.logger('Proxy Init: loaded temp data store ass fallback former data');
                    formerDataStoreValid = true;
                }
            }
        } catch (_err) {
            // ignore
        }
    }

    if (!_options.formerRegistrationData || !_options.formerRegistrationData.frc) {
        // frc contains 313 random bytes, encoded as base64
        const frcBuffer = Buffer.alloc(313);
        for (let i = 0; i < 313; i++) {
            frcBuffer.writeUInt8(Math.floor(Math.random() * 255), i);
        }
        initialCookies.frc = frcBuffer.toString('base64');
    }
    else {
        _options.logger && _options.logger('Proxy Init: reuse frc from former data');
        initialCookies.frc = _options.formerRegistrationData.frc;
    }

    if (!_options.formerRegistrationData || !_options.formerRegistrationData['map-md']) {
        initialCookies['map-md'] = Buffer.from(`{"device_user_dictionary":[],"device_registration_data":{"software_version":"1"},"app_identifier":{"app_version":"${ALEXA_APP_VERSION}","bundle_id":"com.amazon.echo"}}`).toString('base64');
    }
    else {
        _options.logger && _options.logger('Proxy Init: reuse map-md from former data');
        initialCookies['map-md'] = _options.formerRegistrationData['map-md'];
    }

    let deviceId = '';
    if (!_options.formerRegistrationData || !_options.formerRegistrationData.deviceId || !formerDataStoreValid) {
        const buf = Buffer.alloc(16); // 16 random bytes
        const bufHex = crypto.randomFillSync(buf).toString('hex').toUpperCase(); // convert into hex = 32x 0-9A-F
        deviceId = Buffer.from(bufHex).toString('hex'); // convert into hex = 64 chars that are hex of hex id
        deviceId += '23413249564c5635564d32573831';
    }
    else {
        _options.logger && _options.logger('Proxy Init: reuse deviceId from former data');
        deviceId = _options.formerRegistrationData.deviceId;
    }

    try {
        const formerDataStore = {
            'storeVersion': FORMERDATA_STORE_VERSION,
            'deviceId': deviceId,
            'map-md': initialCookies['map-md'],
            'frc': initialCookies.frc
        };
        fs.writeFileSync(formerDataStorePath, JSON.stringify(formerDataStore), 'utf8');
    }
    catch (_err) {
        // ignore
    }

    function base64URLEncode(str) {
        return str.toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    }
    function sha256(buffer) {
        return crypto.createHash('sha256').update(buffer).digest();
    }
    const code_verifier = base64URLEncode(crypto.randomBytes(32));
    const code_challenge = base64URLEncode(sha256(code_verifier));

    let proxyCookies = '';
    let returnedInitUrl;

    function buildInitialUrl() {
        return `https://www.${_options.baseAmazonPage}/ap/signin?openid.return_to=https%3A%2F%2Fwww.${_options.baseAmazonPage}%2Fap%2Fmaplanding&openid.assoc_handle=amzn_dp_project_dee_ios${_options.baseAmazonPageHandle}&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&pageId=amzn_dp_project_dee_ios${_options.baseAmazonPageHandle}&accountStatusPolicy=P1&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.mode=checkid_setup&openid.ns.oa2=http%3A%2F%2Fwww.${_options.baseAmazonPage}%2Fap%2Fext%2Foauth%2F2&openid.oa2.client_id=device%3A${deviceId}&openid.ns.pape=http%3A%2F%2Fspecs.openid.net%2Fextensions%2Fpape%2F1.0&openid.oa2.response_type=code&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.pape.max_auth_age=0&openid.oa2.scope=device_auth_access&openid.oa2.code_challenge_method=S256&openid.oa2.code_challenge=${code_challenge}&language=${_options.amazonPageProxyLanguage}`;
    }

    function rewriteProxyPath(url, req) {
        const urlHost = amazonHostFromProxyPath(url);
        if (urlHost) {
            return url.replace(new RegExp(`^/${escapeRegex(urlHost)}`), '') || '/';
        }
        if (req && req.headers && req.headers.host === `${_options.proxyOwnIp}:${_options.proxyPort}` && url === '/') {
            const initialUrl = returnedInitUrl || buildInitialUrl();
            const parsed = new URL(initialUrl);
            return `${parsed.pathname}${parsed.search}`;
        }
        return url;
    }

    // proxy middleware options
    const optionsAlexa = {
        target: `https://alexa.${_options.baseAmazonPage}`,
        changeOrigin: true,
        ws: false,
        pathRewrite: rewriteProxyPath,
        router: router,
        hostRewrite: true,
        followRedirects: false,
        logLevel: _options.proxyLogLevel,
        onError: onError,
        onProxyRes: onProxyRes,
        onProxyReq: onProxyReq,
        headers: {
            'accept-language': _options.acceptLanguage
        },
        cookieDomainRewrite: {
            '*': ''
        },
        cookiePathRewrite: {
            '*': '/'
        }
    };
    if (_options.logger) optionsAlexa.logProvider = function logProvider() {
        return {
            log: _options.logger.log || _options.logger,
            debug: _options.logger.debug || _options.logger,
            info: _options.logger.info || _options.logger,
            warn: _options.logger.warn || _options.logger,
            error: _options.logger.error || _options.logger
        };
    };

    function router(req) {
        const url = (req.originalUrl || req.url);
        _options.logger && _options.logger(`Router: ${url} / ${req.method} / ${JSON.stringify(req.headers)}`);
        if (req.headers.host === `${_options.proxyOwnIp}:${_options.proxyPort}`) {
            const urlHost = amazonHostFromProxyPath(url);
            if (urlHost) {
                return `https://${urlHost}`;
            }
            const refererHost = amazonHostFromProxyUrl(req.headers.referer);
            if (refererHost) {
                return `https://${refererHost}`;
            }
            if (url === '/') { // initial redirect
                returnedInitUrl =  buildInitialUrl();
                _options.logger && _options.logger(`Alexa-Cookie: Initial Page Request: ${returnedInitUrl}`);
                const parsedInitUrl = new URL(returnedInitUrl);
                return `${parsedInitUrl.protocol}//${parsedInitUrl.host}`;
            }
            else {
                return `https://${defaultAmazonHost}`;
            }
        }
        return `https://alexa.${_options.baseAmazonPage}`;
    }

    function onError(err, req, res) {
        _options.logger && _options.logger(`ERROR: ${err}`);
        try {
            res.writeHead(500, {
                'Content-Type': 'text/plain'
            });
            res.end(`Proxy-Error: ${err}`);
        } catch (err) {
            // ignore
        }
    }

    function replaceHosts(data) {
        //const dataOrig = data;
        data = data.replace(/&#x2F;/g, '/');
        for (const host of amazonProxyHosts) {
            const hostRegex = new RegExp(`https?://${escapeRegex(host)}:?[0-9]*/`, 'g');
            data = data.replace(hostRegex, `${proxyBase}${host}/`);
        }
        //_options.logger && _options.logger('REPLACEHOSTS: ' + dataOrig + ' --> ' + data);
        return data;
    }

    function replaceHostsBack(data) {
        for (const host of amazonProxyHosts) {
            const hostRegex = new RegExp(`${escapeRegex(proxyBase)}${escapeRegex(host)}/`, 'g');
            data = data.replace(hostRegex, `https://${host}/`);
        }
        if (data === proxyBase) {
            data = returnedInitUrl;
        }
        else if (data.startsWith(proxyBase)) {
            data = `https://${defaultAmazonHost}/${data.slice(proxyBase.length)}`;
        }
        return data;
    }

    function parseQueryParams(data) {
        const paramStart = data && data.indexOf('?');
        if (paramStart === -1 || paramStart === undefined) return {};
        return querystring.parse(data.substr(paramStart + 1));
    }

    function isProxySuccessUrl(data) {
        if (!data) return false;
        if (data.includes('/spa/index.html')) return true;
        if (!data.includes('/ap/maplanding?')) return false;
        return !!parseQueryParams(data)['openid.oa2.authorization_code'];
    }

    function onProxyReq(proxyReq, req/*, _res*/) {
        const url = req.originalUrl || req.url;
        if (url.endsWith('.ico') || url.endsWith('.js') || url.endsWith('.ttf') || url.endsWith('.svg') || url.endsWith('.png') || url.endsWith('.appcache')) return;
        //if (url.startsWith('/ap/uedata')) return;

        _options.logger && _options.logger(`Alexa-Cookie: Proxy-Request: ${req.method} ${url}`);
        //_options.logger && _options.logger('Alexa-Cookie: Proxy-Request-Data: ' + customStringify(proxyReq, null, 2));

        if (typeof proxyReq.getHeader === 'function') {
            _options.logger && _options.logger(`Alexa-Cookie: Headers: ${JSON.stringify(proxyReq.getHeaders())}`);
            let reqCookie = proxyReq.getHeader('cookie');
            if (reqCookie === undefined) {
                reqCookie = '';
            }
            for (const cookie of Object.keys(initialCookies)) {
                if (!reqCookie.includes(`${cookie}=`)) {
                    reqCookie += `; ${cookie}=${initialCookies[cookie]}`;
                }
            }
            if (reqCookie.startsWith('; ')) {
                reqCookie = reqCookie.substr(2);
            }
            proxyReq.setHeader('cookie', reqCookie);
            if (!proxyCookies.length) {
                proxyCookies = reqCookie;
            } else {
                proxyCookies += `; ${reqCookie}`;
            }
            _options.logger && _options.logger(`Alexa-Cookie: Headers: ${JSON.stringify(proxyReq.getHeaders())}`);
        }

        let modified = false;
        if (req.method === 'POST') {
            if (typeof proxyReq.getHeader === 'function' && proxyReq.getHeader('referer')) {
                const fixedReferer = replaceHostsBack(proxyReq.getHeader('referer'));
                if (fixedReferer ) {
                    proxyReq.setHeader('referer', fixedReferer);
                    _options.logger && _options.logger(`Alexa-Cookie: Modify headers: Changed Referer: ${fixedReferer}`);
                    modified = true;
                }
            }
            if (typeof proxyReq.getHeader === 'function' && proxyReq.getHeader('origin') !== `https://${proxyReq.getHeader('host')}`) {
                proxyReq.setHeader('origin', `https://${proxyReq.getHeader('host') || defaultAmazonHost}`);
                _options.logger && _options.logger('Alexa-Cookie: Modify headers: Changed Origin');
                modified = true;
            }

            let postBody = '';
            req.on('data', chunk => {
                postBody += chunk.toString(); // convert Buffer to string
            });
        }
        _options.proxyLogLevel === 'debug' && _options.logger && _options.logger(`Alexa-Cookie: Proxy-Request: (modified:${modified})${customStringify(proxyReq, null, 2)}`);
    }

    function onProxyRes(proxyRes, req, res) {
        const url = req.originalUrl || req.url;
        if (url.endsWith('.ico') || url.endsWith('.js') || url.endsWith('.ttf') || url.endsWith('.svg') || url.endsWith('.png') || url.endsWith('.appcache')) return;
        if (url.startsWith('/ap/uedata')) return;
        //_options.logger && _options.logger('Proxy-Response: ' + customStringify(proxyRes, null, 2));
        let reqestHost = null;
        if (proxyRes.socket && proxyRes.socket._host) reqestHost = proxyRes.socket._host;
        _options.logger && _options.logger(`Alexa-Cookie: Proxy Response from Host: ${reqestHost}`);
        _options.proxyLogLevel === 'debug' && _options.logger && _options.logger(`Alexa-Cookie: Proxy-Response Headers: ${customStringify(proxyRes.headers, null, 2)}`);
        _options.proxyLogLevel === 'debug' && _options.logger && _options.logger(`Alexa-Cookie: Proxy-Response Outgoing: ${customStringify(proxyRes.socket.parser.outgoing, null, 2)}`);
        //_options.logger && _options.logger('Proxy-Response RES!!: ' + customStringify(res, null, 2));

        if (proxyRes && proxyRes.headers && proxyRes.headers['set-cookie']) {
            // make sure cookies are also sent to http by remove secure flags
            for (let i = 0; i < proxyRes.headers['set-cookie'].length; i++) {
                proxyRes.headers['set-cookie'][i] = proxyRes.headers['set-cookie'][i].replace('Secure', '');
            }
            proxyCookies = addCookies(proxyCookies, proxyRes.headers);
        }
        _options.logger && _options.logger(`Alexa-Cookie: Cookies handled: ${JSON.stringify(proxyCookies)}`);

        const outgoing = proxyRes.socket && proxyRes.socket.parser && proxyRes.socket.parser.outgoing;
        const successUrl = [
            proxyRes.headers.location,
            outgoing && outgoing.method === 'GET' && outgoing.path,
            outgoing && outgoing.getHeader && outgoing.getHeader('location')
        ].find(isProxySuccessUrl);

        if (successUrl) {
            _options.logger && _options.logger('Alexa-Cookie: Proxy detected SUCCESS!!');

            const queryParams = parseQueryParams(successUrl);

            proxyRes.statusCode = 302;
            proxyRes.headers.location = `http://${_options.proxyOwnIp}:${_options.proxyPort}/cookie-success`;
            delete proxyRes.headers.referer;

            _options.logger && _options.logger(`Alexa-Cookie: Proxy catched cookie: ${proxyCookies}`);
            _options.logger && _options.logger(`Alexa-Cookie: Proxy catched parameters: ${JSON.stringify(queryParams)}`);

            callbackCookie && callbackCookie(null, {
                'loginCookie': sanitizeAmazonCookie(proxyCookies),
                'authorization_code': queryParams['openid.oa2.authorization_code'],
                'frc': initialCookies.frc,
                'map-md': initialCookies['map-md'],
                'deviceId': deviceId,
                'verifier': code_verifier
            });
            return;
        }

        // If we detect a redirect, rewrite the location header
        if (proxyRes.headers.location) {
            _options.logger && _options.logger(`Redirect: Original Location ----> ${proxyRes.headers.location}`);
            proxyRes.headers.location = replaceHosts(proxyRes.headers.location);
            if (reqestHost && amazonProxyHosts.includes(reqestHost) && proxyRes.headers.location.startsWith('/')) {
                proxyRes.headers.location = `http://${_options.proxyOwnIp}:${_options.proxyPort}/${reqestHost}${proxyRes.headers.location}`;
            }
            _options.logger && _options.logger(`Redirect: Final Location ----> ${proxyRes.headers.location}`);
            return;
        }

        modifyResponse(res, (proxyRes && proxyRes.headers ? proxyRes.headers['content-encoding'] || '' : ''), function(body) {
            if (body) {
                const bodyOrig = body;
                body = replaceHosts(body);
                if (body !== bodyOrig) {
                    _options.logger && _options.logger('Alexa-Cookie: MODIFIED Response Body to rewrite URLs');
                    _options.logger && _options.logger('');
                    _options.logger && _options.logger('');
                    _options.logger && _options.logger('');
                }
            }
            return body;
        });
    }

    // create the proxy (without context)
    const myProxy = proxy('!/cookie-success', optionsAlexa);

    // mount `exampleProxy` in web server
    const app = express();

    app.use(myProxy);
    app.get('/cookie-success', function(req, res) {
        res.send(_options.proxyCloseWindowHTML);
    });
    if (_options.proxyPort< 1 || _options.proxyPort > 65535) {
        _options.logger && _options.logger(`Alexa-Cookie: Error: Port ${_options.proxyPort} invalid. Use random port.`);
        _options.proxyPort = undefined;
    }
    const server = app.listen(_options.proxyPort, _options.proxyListenBind, function() {
        _options.logger && _options.logger(`Alexa-Cookie: Proxy-Server listening on port ${server.address().port}`);
        callbackListening && callbackListening(server);
        callbackListening = null;
    }).on('error', err => {
        _options.logger && _options.logger(`Alexa-Cookie: Proxy-Server Error: ${err}`);
        callbackListening && callbackListening(null);
        callbackListening = null;
    });

}

module.exports.initAmazonProxy = initAmazonProxy;
