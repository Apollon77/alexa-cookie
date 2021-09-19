/* jshint -W097 */
/* jshint -W030 */
/* jshint strict: false */
/* jslint node: true */
/* jslint esversion: 6 */

const alexaCookie = require('../alexa-cookie');
const commander = require('commander'); 
const program = new commander.Command();

program
  .option('-l, --logger <log target>', 'Where to log to', console.log)
  .option('-p, --amazonPage <page>', 'optional: possible to use with different countries, default is "amazon.de"')
  .option('-P, --baseAmazonPage <amazon.com|amazon.co.jp>', 'optional: Change the Proxy Amazon Page - all "western countries" directly use amazon.com! Change to amazon.co.jp for Japan')
  .option('-a, --amazonPageProxyLanguage <lang>', 'optional: language to be used for the Amazon Sign-in page the proxy calls. default is "de_DE"')
  .option('-L, --acceptLanguage <lang>', 'optional: webpage language, should match to amazon-Page, default is "de-DE"')
  .option('-u, --userAgent <Browser>', 'optional: own userAgent to use for all request, overwrites default one, should not be needed')
  .option('-H, --proxyOwnIp <hostname>', 'provide own IP or hostname to later access the proxy. needed to setup all rewriting and proxy stuff internally', 'localhost')
  .option('-P, --proxyPort <port>', 'optional: use this port for the proxy, default is 8080', 8080)
  .option('-B, --proxyListenBind <IP>', 'optional: set this to bind the proxy to a special IP, default is "0.0.0.0"')
  .option('-V, --proxyLogLevel <error|warn|info|debug>', 'optional: Loglevel of Proxy, default "warn"');
program.parse();

alexaCookie.generateAlexaCookie( program.opts(), (err, result) => {
    if (result && result.refreshToken) {
        console.log(result.refreshToken);
        alexaCookie.stopProxyServer();
    }else{
        console.error( err + ' / ' + JSON.stringify(result));
    }
});
