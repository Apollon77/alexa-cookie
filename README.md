# alexa-cookie

[![NPM version](http://img.shields.io/npm/v/alexa-cookie2.svg)](https://www.npmjs.com/package/alexa-cookie2)
[![Downloads](https://img.shields.io/npm/dm/alexa-cookie2.svg)](https://www.npmjs.com/package/alexa-cookie2)
![Test and Release](https://github.com/Apollon77/alexa-cookie/workflows/Test%20and%20Release/badge.svg)

Library to generate/retrieve a cookie including a csrf for alexa remote

## Disclaimer
**All product and company names or logos are trademarks™ or registered® trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them or any associated subsidiaries! This personal project is maintained in spare time and has no business goal.**
**ALEXA is a trademark of AMAZON TECHNOLOGIES, INC.**

## Description
This library can be used to get the cookies needed to access Amazon Alexa services from outside. It authenticates with Amazon and gathers all needed details. These details are returned in the callback.
If the automatic authentication fails (which is more common case in the meantime because of security checks from amazon like a needed Captcha or because you enabled two factor authentication) the library can also setup a proxy server to allow the manual login and will catch the cookie by itself. Using this proxy you can enter needed 2FA codes or solve captchas and still do not need to trick around to get the cookie.

Starting with version 2.0 of this library the proxy approach was changed to be more "as the Amazon mobile Apps" which registers a device at Amazon and uses OAuth tokens to handle the automatic refresh of the cookies afterwards. This should work seamless. A cookie is valid for 14 days, so it is preferred to refresh the cookie after 5-13 days (please report if it should be shorter).

## Troubleshooting for getting the cookie and tokens initially
If you still use the E-Mail or SMS based 2FA flow then this might not work. Please update the 2FA/OTP method in the amazon settings to the current process.

If you open the Proxy URL from a mobile device where also the Alexa App is installed on it might be that it do not work because Amazon might open the Alexa App. So please use a device or PC where the Alexa App is not installed

If you see a page that tells you that "alexa.amazon.xx is deprecated" and you should use the alexa app and with a QR code on it when you enter the Proxy URL" then this means that you call the proxy URL with a different IP/Domainname then the one you entered in the "proxy own IP" settings or you adjusted the IP shown in the Adapter configuration. The "proxy own IP" setting **needs to** match the IP/Domainname you use to call the proxy URL!

## Example:
See example folder!

* **example.js** shows how to use the library to initially get a cookie
* **refresh.js** shown how to use the library to refresh the cookies

## Usage 
Special note for callback return for parameter result:

### When automatic cookie retrieval worked (uncommon)
If the library was able to automatically log you in and get the cookie (which is the more uncommon case in the meantime) the object returned will contain keys "cookie" and "csrf" to use.

### When proxy was used (preferred and more common case)
If the Proxy was used (or especially when "proxyOnly" was set in options) then result is a object with much more data.

Important for the further interaction with alexa are the keys "localCookie" (same as "cookie" above) and pot. "crsf". I decided for different keys to make sure the next lines are understood by the developer ... 

**Please store the returned object and provide this object in all subsequent calls to the library in the options object in key "formerRegistrationData" as shown in the example!**

If you not do this a new device is created each time the proxy is used which can end up in having many unused devices (such a device is like a mobile phone where you use the Alexa App with).

Please use the new method "refreshAlexaCookie" to refresh the cookie data. It takes the same options object as the other method and requires the key "formerRegistrationData". It returns an updated object will all data as above. Please also store this and provide for subsequent calls!

Since 4.0.0 of this library a new key called "macDms" is also returned when cookies are generated or refreshed. This is (right now Oct 2021) needed to use the Push Connection (alexa-remote library). Better strt also persisting this field, might be needed more later on. 

## Thanks:
A big thanks go to soef for the initial version of this library and to many other community users to support in finding out what Amazon changes here and there.

Partly based on [Amazon Alexa Remote Control](http://blog.loetzimmer.de/2017/10/amazon-alexa-hort-auf-die-shell-echo.html) (PLAIN shell) and [alexa-remote-control](https://github.com/thorsten-gehrig/alexa-remote-control) and the the Proxy idea from [OpenHab-Addon](https://github.com/openhab/openhab2-addons/blob/f54c9b85016758ff6d271b62d255bbe41a027928/addons/binding/org.openhab.binding.amazonechocontrol). Also the new way to refresh cookie and all needed changes were developed in close cooperation with @mgeramb 
Thank you for that work.

## Changelog:
### 5.0.3 (2025-07-13)
* (Apollon77) Update some version details to sync with Alexa App

### 5.0.2 (2023-11-25)
* (Apollon77) Adjust some texts

### 5.0.1 (2023-11-24)
* (adn77) make registered device name configurable by Appname
* (Apollon77) Prevent some error/crash cases

### 5.0.0 (2023-09-08)
* IMPORTANT: Node.js 16 is now required minimum Node.js version!
* (Apollon77) Enhance registration process by also registering the app capabilities to allow usage of new HTTP/2 push connection

### 4.2.0 (2023-08-08)
* (Hive) Adds the ability to alter the close proxy message

### 4.1.3 (2022-08-03)
* (Apollon77) Fix device registration and token exchange in other regions
* (Apollon77) Use the chosen App name also for refreshing of tokens
* (Apollon77) General updates

### 4.1.2 (2022-07-19)
* (Apollon77) Prevent crash case

### 4.1.1 (2022-07-18)
* (Apollon77/bbindreiter) Update used User-Agent for some requests

### 4.1.0 (2022-07-18)
* (Apollon77) Allow to overwrite the used App-Name for the Amazon App Registration.
* (Apollon77) Include the used app name also in the response

### 4.0.3 (2022-07-06)
* (Apollon77) Update some request meta data to match current Alexa Apps

### 4.0.2 (2022-06-30)
* (Apollon77) Prevent potential crash cases

### 4.0.1 (2021-10-11)
* (Apollon77) Adjust call headers

### 4.0.0 (2021-10-11)
* IMPORTANT: Node.js 10 support is dropped, supports LTS versions of Node.js starting with 12.x
* (Apollon77) Add support to get macDms with relevant data from the device registration process to use in push connection.
* (adn77) Update Login Flow to use match to most current Alexa App flow using code auth
* (Apollon77) Update deps, drop Node.js 10 support

### 3.4.3 (2021-04-18)
* (Apollon77) handle potential crash case (Sentry IOBROKER-ALEXA2-86)

### 3.4.2 (2020-11-23)
* (Apollon77) handle potential crash cases (Sentry IOBROKER-ALEXA2-23, IOBROKER-ALEXA2-2B)

### 3.4.1 (2020-07-24)
* (Apollon77) Try to revert one change and only use BaseHandle when .jp is on the end of the Domainname for japanese

### 3.4.0 (2020-07-19)
* (Apollon77) Do not reuse device id from formerRegistrationData if store is invalid
* (Apollon77) Allow to set path for former file from extern

### 3.3.3 (2020-07-16)
* (Apollon77) Another try to work around Amazon changes

### 3.3.2 (2020-07-15)
* (Apollon77) Another try to work around Amazon changes

### 3.3.1 (2020-07-15)
* (Apollon77) Another try to work around Amazon changes

### 3.3.0 (2020-07-13)
* (Apollon77) Adjust to latest Amazon changes
* (Apollon77) Remember latest virtual device settings to adress amazons new security measures
* (Apollon77) Adjust handling for japanese amazon region
* (Apollon77) Handle error correctly when proxy server could not be initialized correctly (Sentry IOBROKER-ALEXA2-1E)
* (Apollon77) handle all object changes correctly (Sentry IOBROKER-ALEXA2-1F)
* (Apollon77) handle error cases better (Sentry IOBROKER-ALEXA2-1N)

### 3.2.1 (2020-06-17)
* (Apollon77) another optimization for Node.js 14

### 3.2.0 (2020-06-15)
* (Apollon77) Make compatible with Node.js 14
* (Apollon77) Adjust to changes from Amazon so that initial Proxy process works again 
* (Apollon77) Add new parameter baseAmazonPage to allow use the library also for other regions (e.g. set to amazon.co.jp for japanese)

### 3.0.3 (2020.03.16)
* (Apollon77) Prevent error for empty Cookie cases (on communication errors)

### 3.0.2 (2019.12.27)
* (Apollon77) Prevent error when no headers are existent

### 3.0.1 (2019.12.24)
* (Apollon77) Prevent error thrown when proxy port already in use

### 3.0.0
* (tonesto7 / Gabriele-V) Added others CSRF after Amazon changes
* (Apollon77) update deps
* (Apollon77) Add GitHub Actions for check and release
* (Apollon77) Rebuild a bit to allow parallel instances to work, should be compatible ...

### 2.1.0
* (Apollon77) Adjust to get CSRF from different URLs after changes from Amazon

### 2.0.1
* (Apollon77) Fix refresh problem, hopefully

### 2.0.0
* (Apollon77) Switch Proxy approach to use device registration logic and allow refreshing of cookies. Be aware: Breaking changes in API!!

### 1.0.3
* (Apollon77) try to better handle relative redirects from amazon (seen by 2FA checks)

### 1.0.2
* (Apollon77) more Amazon tweaks

### 1.0.1
* (Apollon77) better handle errors in automatic cookie generation

### 1.0.0
* (Apollon77) handle Amazon change

### 0.2.x
* (Apollon77) 0.2.2: fix encoding of special characters in email and password
* (Apollon77) 0.2.1: Cleanup to prepare release
* (Apollon77) 0.2.0: Add option to use a proxy to also retrieve the credentials if the automatic retrieval fails
* (Apollon77) 0.2.0: Optimize automatic cookie retrieval, remove MacOS user agent again because the Linux one seems to work better

### 0.1.x
* (Apollon77) 0.1.3: Use specific User-Agents for Win32, MacOS and linux based platforms
* (Apollon77) 0.1.2: Log the used user-Agent, Accept-Language and Login-URL
* (Apollon77) 0.1.1: update to get it working again and sync to [alexa-remote-control](https://github.com/thorsten-gehrig/alexa-remote-control)

### 0.0.x
* Versions by soef
