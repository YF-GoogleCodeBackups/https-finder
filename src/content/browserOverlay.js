/*
 * Developer : Kevin Jacobs (httpsfinder@gmail.com), www.kevinajacobs.com
 * Date : 07/06/2011
 * All code (c)2011 all rights reserved
 */

//'use strict';

if (!httpsfinder) var httpsfinder = {
    prefs: null, //prefs object for httpsfinder branch
    strings: null, //Strings object for httpsfinder strings
    debug: null //verbose logging bool
};


//detect handles background detection and http observation
httpsfinder.detect = {
    //Not a great solution, but this is for problematic domains.
    //Google image search over ssl is one, so we won't cache results there.
    cacheExempt: ["www.google.com", "translate.google.com"],

    QueryInterface: function(aIID){
        if (aIID.equals(Components.interfaces.nsIObserver) 
            || aIID.equals(Components.interfaces.nsISupports))
            return this;
        throw Components.results.NS_NOINTERFACE;
    },

    //Watches HTTP responses, filters and calls detection if needed
    observe: function(request,aTopic, aData){
        if (aTopic == "http-on-examine-response") {
            request.QueryInterface(Components.interfaces.nsIHttpChannel);
            if(!httpsfinder.prefs.getBoolPref("enable"))
                return;

            if((request.responseStatus == 200 || request.responseStatus == 301
                || request.responseStatus == 304) && request.URI.scheme == "http")
                var loadFlags = httpsfinder.detect.getStringArrayOfLoadFlags(request.loadFlags);
            else
                return;

            if(loadFlags.indexOf("LOAD_DOCUMENT_URI") != -1 && loadFlags.indexOf("LOAD_INITIAL_DOCUMENT_URI") != -1){
                if(httpsfinder.browserOverlay.isWhitelisted(request.URI.host.toLowerCase())){
                    if(httpsfinder.debug)
                        dump("Canceling detection on " + request.URI.host.toLowerCase() + ". Host is whitelisted\n");
                    return;
                }

                var browser = httpsfinder.detect.getBrowserFromChannel(request);
                if (browser == null){
                    if(httpsfinder.debug)
                        dump("httpsfinder browser cannot be found for channel\n");
                    return;
                }

                var host = request.URI.host.toLowerCase();
                try{
                    if(httpsfinder.detect.hostsMatch(browser.contentDocument.baseURIObject.host.toLowerCase(),host) &&
                        httpsfinder.results.goodSSL.indexOf(request.URI.host.toLowerCase()) != -1){
                        if(httpsfinder.debug)
                            dump("Canceling detection on " + request.URI.host.toLowerCase() + ". Good SSL already cached for host.\n");
                        httpsfinder.detect.handleCachedSSL(browser, request);
                        return;
                    }
                }catch(e){
                    if(e.name == 'NS_ERROR_FAILURE')
                        Components.utils.reportError("https finder cannot match URI to browser request.\n");
                }

                //Push to whitelist so we don't spam with multiple detection requests - may be removed later depending on result
                if(!httpsfinder.browserOverlay.isWhitelisted(host)){
                    httpsfinder.results.whitelist.push(host);
                    if(httpsfinder.debug){
                        dump("httpsfinder Blocking detection on " + request.URI.host + " until OK response received\n");
                        dump("httpsfinder Starting HTTPS detection for " + request.URI.asciiSpec + "\n");
                    }
                }

                httpsfinder.detect.detectSSL(browser, request);
            }
        }
    },

    register: function() {
        var observerService = Components.classes["@mozilla.org/observer-service;1"]
        .getService(Components.interfaces.nsIObserverService);
        observerService.addObserver(httpsfinder.detect, "http-on-examine-response", false);
    },

    unregister: function() {
        var observerService = Components.classes["@mozilla.org/observer-service;1"]
        .getService(Components.interfaces.nsIObserverService);
        observerService.removeObserver(httpsfinder.detect, "http-on-examine-response");
    },

    hostsMatch: function(host1, host2){
        //check domain name of page location and detected host. Slice after first . to ignore subdomains
        if(host1.slice(host1.indexOf(".",0) + 1,host1.length) == host2.slice(host2.indexOf(".",0) + 1,host2.length))
            return true;
        else
            return false;
    },

    //HTTPS detection function - does HEAD falling back to GET, or just GET depending on user settings
    detectSSL: function(aBrowser, request){
        var requestURL = request.URI.asciiSpec.replace("http://", "https://");

        //If user preference specifies GET detection only
        if(!httpsfinder.prefs.getBoolPref("headfirst")){
            var getReq = new XMLHttpRequest();
            getReq.mozBackgroundRequest = true;
            getReq.open('GET', requestURL, true);
            getReq.channel.loadFlags |= Components.interfaces.nsIRequest.LOAD_BYPASS_CACHE;
            getReq.onreadystatechange = function (aEvt) {
                if (getReq.readyState == 4){
                    httpsfinder.detect.handleDetectionResponse(aBrowser, getReq, requestURL);
                }
            };
            getReq.send(null);
        }
        else{ //Otherwise, try HEAD and fall back to GET if necessary (default bahavior)
            var headReq = new XMLHttpRequest();
            headReq.mozBackgroundRequest = true;
            headReq.open('HEAD', requestURL, true);
            headReq.channel.loadFlags |= Components.interfaces.nsIRequest.LOAD_BYPASS_CACHE;
            headReq.onreadystatechange = function (aEvt) {
                if (headReq.readyState == 4){
                    if(headReq.status == 200 || (headReq.status != 405 && headReq.status != 403))
                        httpsfinder.detect.handleDetectionResponse(aBrowser,headReq, requestURL);
                    else if(headReq.status == 405 || headReq.status == 403){
                        dump("httpsfinder detection falling back to GET for " + requestURL + "\n");
                        var getReq = new XMLHttpRequest();
                        getReq.mozBackgroundRequest = true;
                        getReq.open('GET', requestURL, true);
                        getReq.channel.loadFlags |= Components.interfaces.nsIRequest.LOAD_BYPASS_CACHE;
                        getReq.onreadystatechange = function (aEvt) {
                            if (getReq.readyState == 4)
                                httpsfinder.detect.handleDetectionResponse(aBrowser, getReq, requestURL);
                        };
                        getReq.send(null);
                    }
                }
            };
            headReq.send(null);
        }
    },

    //Get load flags for HTTP observer. We use these to filter normal http requests from page load requests
    getStringArrayOfLoadFlags : function(flags) {
        var flagsArr = [];

        //Look for the two load flags that indicate a page load (ignore others)
        if (flags & Components.interfaces.nsIChannel.LOAD_DOCUMENT_URI) 
            flagsArr.push("LOAD_DOCUMENT_URI");        
        if (flags & Components.interfaces.nsIChannel.LOAD_INITIAL_DOCUMENT_URI) 
            flagsArr.push("LOAD_INITIAL_DOCUMENT_URI");
        
        return flagsArr;
    },

    //Used by HTTP observer to match requests to tabs
    getBrowserFromChannel: function (aChannel) {
        try {
            var notificationCallbacks = aChannel.notificationCallbacks ? aChannel.notificationCallbacks : aChannel.loadGroup.notificationCallbacks;
            if (!notificationCallbacks)
                return null;
            var domWin = notificationCallbacks.getInterface(Components.interfaces.nsIDOMWindow);
            return gBrowser.getBrowserForDocument(domWin.top.document);
        }
        catch (e) {
            return null;
        }
    },

    //If good SSL has alread been found during this session, skip new detection and use this function
    handleCachedSSL: function(aBrowser, request){
        if(request.responseStatus != 200 && request.responseStatus != 301 && request.responseStatus != 302)
            return;

        var nb = gBrowser.getNotificationBox(aBrowser);
        var sslFoundButtons = [{
            label: httpsfinder.strings.getString("httpsfinder.main.whitelist"),
            accessKey: httpsfinder.strings.getString("httpsfinder.main.whitelistKey"),
            popup: null,
            callback: httpsfinder.browserOverlay.whitelistDomain
        },{
            label: httpsfinder.strings.getString("httpsfinder.main.noRedirect"),
            accessKey: httpsfinder.strings.getString("httpsfinder.main.noRedirectKey"),
            popup: null,
            callback: httpsfinder.browserOverlay.redirectNotNow
        },{
            label: httpsfinder.strings.getString("httpsfinder.main.yesRedirect"),
            accessKey: httpsfinder.strings.getString("httpsfinder.main.yesRedirectKey"),
            popup: null,
            callback: httpsfinder.browserOverlay.redirect
        }];


        if(httpsfinder.prefs.getBoolPref("autoforward"))
            httpsfinder.browserOverlay.redirectAuto(aBrowser, request);
        else if(httpsfinder.results.tempNoAlerts.indexOf(request.URI.host) == -1 &&
            !httpsfinder.prefs.getBoolPref("httpsfoundalert")){
            var key = "httpsfinder-https-found" + gBrowser.getBrowserIndexForDocument(aBrowser.contentDocument);

            nb.appendNotification(httpsfinder.strings.getString("httpsfinder.main.httpsFoundPrompt"),
                key,'chrome://httpsfinder/skin/httpsAvailable.png',
                nb.PRIORITY_INFO_LOW, sslFoundButtons);


            if(httpsfinder.prefs.getBoolPref("dismissAlerts"))
                setTimeout(function(){
                    httpsfinder.browserOverlay.removeNotification(key)
                },httpsfinder.prefs.getIntPref("alertDismissTime") * 1000, 'httpsfinder-https-found');
        }
    },

    //Callback function for our HTTPS detection request
    handleDetectionResponse: function(aBrowser, sslTest){
        //Session whitelist host and return if cert is bad or status is not OK.
        var host = sslTest.channel.URI.host.toLowerCase();
        var request = sslTest.channel;

        if(httpsfinder.detect.cacheExempt.indexOf(host) != -1){
            if(httpsfinder.debug)
                dump("httpsfinder removing " + host + " from whitelist (exempt from saving results on this host)\n");
            httpsfinder.browserOverlay.removeFromWhitelist(null, aBrowser.contentDocument.baseURIObject.host.toLowerCase());
        }

        if(sslTest.status != 200 && sslTest.status != 301 && sslTest.status != 302 && httpsfinder.results.goodSSL.indexOf(host) == -1){
            if(httpsfinder.debug)
                dump("httpsfinder leaving " + host + " in whitelist (return status code " + sslTest.status + ")\n");
            return;
        }
        else if(!httpsfinder.detect.testCertificate(sslTest.channel) && httpsfinder.results.goodSSL.indexOf(host) == -1){
            if(httpsfinder.debug)
                dump("httpsfinder leaving " + host + " in whitelist (bad SSL certificate)\n");
            return;
        }
        else
            for(var i=0; i<httpsfinder.results.whitelist.length; i++)
                if(httpsfinder.results.whitelist[i] == host){
                    httpsfinder.results.whitelist.splice(i,1);
                    if(httpsfinder.debug)
                        dump("httpsfinder unblocking detection on " + host + "\n");
                }

        //If the code gets to this point, the HTTPS is good.

        //Push host to good SSL list (remember result and skip repeat detection)
        if(httpsfinder.results.goodSSL.indexOf(host) == -1){
            httpsfinder.browserOverlay.removeFromWhitelist(null,host);
            httpsfinder.results.goodSSL.push(host);
            if(httpsfinder.debug)
                dump("Pushing " + host + " to good SSL list\n");
            if(httpsfinder.browserOverlay.isWhitelisted(host))
                httpsfinder.browserOverlay.removeFromWhitelist(null, host);
        }
        else if(!httpsfinder.results.goodSSL.indexOf(aBrowser.contentDocument.baseURIObject.host.toLowerCase()) == -1){
            let host = aBrowser.contentDocument.baseURIObject.host.toLowerCase();
            httpsfinder.browserOverlay.removeFromWhitelist(null,host);
            httpsfinder.results.goodSSL.push(host);
            if(httpsfinder.debug) dump("Pushing " + host + " to good SSL list.\n");

            if(httpsfinder.browserOverlay.isWhitelisted(aBrowser.contentDocument.baseURIObject.host.toLowerCase()))
                httpsfinder.browserOverlay.removeFromWhitelist(null, aBrowser.contentDocument.baseURIObject.host.toLowerCase());
        }

        //Check setting and automatically enforce HTTPS
        if(httpsfinder.prefs.getBoolPref("autoforward"))
            httpsfinder.browserOverlay.redirectAuto(aBrowser, request);

        //If auto-enforce is disabled, if host is not in tempNoAlerts (rule already saved)
        //and HTTPS Found alerts are enabled, alert user of good HTTPS
        else  if(httpsfinder.results.tempNoAlerts.indexOf(request.URI.host) == -1 &&
            !httpsfinder.prefs.getBoolPref("httpsfoundalert")){
            if(httpsfinder.detect.hostsMatch(aBrowser.contentDocument.baseURIObject.host.toLowerCase(),host)){

                var nb = gBrowser.getNotificationBox(aBrowser);
                var sslFoundButtons = [{
                    label: httpsfinder.strings.getString("httpsfinder.main.whitelist"),
                    accessKey: httpsfinder.strings.getString("httpsfinder.main.whitelistKey"),
                    popup: null,
                    callback: httpsfinder.browserOverlay.whitelistDomain
                },{
                    label: httpsfinder.strings.getString("httpsfinder.main.noRedirect"),
                    accessKey: httpsfinder.strings.getString("httpsfinder.main.noRedirectKey"),
                    popup: null,
                    callback: httpsfinder.browserOverlay.redirectNotNow
                },{
                    label: httpsfinder.strings.getString("httpsfinder.main.yesRedirect"),
                    accessKey: httpsfinder.strings.getString("httpsfinder.main.yesRedirectKey"),
                    popup: null,
                    callback: httpsfinder.browserOverlay.redirect
                }];
                var key = "httpsfinder-https-found" + gBrowser.getBrowserIndexForDocument(aBrowser.contentDocument);
                
                nb.appendNotification(httpsfinder.strings.getString("httpsfinder.main.httpsFoundPrompt"),
                    key,'chrome://httpsfinder/skin/httpsAvailable.png',
                    nb.PRIORITY_INFO_LOW, sslFoundButtons);
                httpsfinder.browserOverlay.removeFromWhitelist(aBrowser.contentDocument, null);

                if(httpsfinder.prefs.getBoolPref("dismissAlerts"))
                    setTimeout(function(){
                        httpsfinder.browserOverlay.removeNotification(key)
                    },httpsfinder.prefs.getIntPref("alertDismissTime") * 1000, 'httpsfinder-https-found');
            }
            else{
                //Catches certain browser location changes and page content that had load flags to fire detection
                if(httpsfinder.debug)
                    dump("Host mismatch, alert blocked (Document: " +
                        aBrowser.contentDocument.baseURIObject.host.toLowerCase() + " , Detection host: " + host + "\n");
            }
        }
    },

    //Certificate testing done before alerting user of https presence
    testCertificate: function(channel) {
        var secure = false;
        try {
            const Ci = Components.interfaces;
            if (! channel instanceof  Ci.nsIChannel){
                if(httpsfinder.debug)
                    dump("httpsfinder testCertificate: Invalid channel object\n");
                return false;
            }

            var secInfo = channel.securityInfo;
            if (secInfo instanceof Ci.nsITransportSecurityInfo) {
                secInfo.QueryInterface(Ci.nsITransportSecurityInfo);
                // Check security state flags
                if ((secInfo.securityState & Ci.nsIWebProgressListener.STATE_IS_SECURE) ==
                    Ci.nsIWebProgressListener.STATE_IS_SECURE)
                    secure = true;
            }
            //Check SSL certificate details
            if (secInfo instanceof Ci.nsISSLStatusProvider) {
                var cert = secInfo.QueryInterface(Ci.nsISSLStatusProvider).
                SSLStatus.QueryInterface(Ci.nsISSLStatus).serverCert;
                var verificationResult = cert.verifyForUsage(Ci.nsIX509Cert.CERT_USAGE_SSLServer);
                switch (verificationResult) {
                    case Ci.nsIX509Cert.VERIFIED_OK:
                        secure = true;
                        if(httpsfinder.debug)
                            dump("httpsfinder testCertificate: Cert OK (on "+
                                channel.URI.host.toLowerCase()+ ")\n");
                        break;                  
                    default:
                        secure = false;
                        break;
                }
            }
        }
        catch(err){
            secure = false;
            Components.utils.reportError("httpsfinder testCertificate error: " + err.toString() + "\n");
        }
        return secure;
    }
};

//browserOverlay handles most 'browser' code (including alerts except those generated from detection, importing whitelist, startup/shutdown, etc)
httpsfinder.browserOverlay = {
    redirectedTab: [[]], //Tab info for pre-redirect URLs.
    recent: [[]], //Recent auto-redirects used for detecting http->https->http redirect loops. Second subscript holds the tabIndex of the redirect
    lastRecentReset: null, //time counter for detecting redirect loops
    permWhitelistLength: 0, //Count for permanent whitelist items (first x items are permanent, the rest are temp)

    //Window start up - set listeners, read in whitelist, etc
    init: function(){
        Components.utils.import("resource://hfShared/hfShared.js", httpsfinder);
       
        var prefs = Components.classes["@mozilla.org/preferences-service;1"]
        .getService(Components.interfaces.nsIPrefBranch);
        httpsfinder.prefs =  prefs.getBranch("extensions.httpsfinder.");
        
        if(!httpsfinder.prefs.getBoolPref("enable"))
            return;

        //pref change observer
        httpsfinder.prefs.QueryInterface(Components.interfaces.nsIPrefBranch2);
        httpsfinder.prefs.addObserver("", this, false);

        //Listener is used for displaying HTTPS alerts after a page is loaded
        var appcontent = document.getElementById("appcontent");
        if(appcontent)
            appcontent.addEventListener("load", httpsfinder.browserOverlay.onPageLoad, true);

        //Register HTTP observer for HTTPS detection
        httpsfinder.detect.register();

        //Used for auto-dismissing alerts (auto-dismiss timer is started when user clicks on a tab, so they don't miss background alerts)
        if(httpsfinder.prefs.getBoolPref("dismissAlerts")){
            var container = gBrowser.tabContainer;
            container.addEventListener("TabSelect", httpsfinder.browserOverlay.tabChanged, false);
        }

        httpsfinder.strings = document.getElementById("httpsfinderStrings");
        if(httpsfinder.prefs == null || httpsfinder.strings == null){
            dump("httpsfinder cannot load preferences or strings - init() failed\n");
            return;
        }

        /*Try/catch/finally checks version numbers and runs upgrade code if needed.
         * Attempts to recreate db table (in case it has been deleted). Doesn't overwrite though
         */
        try{
            var installedVersion = httpsfinder.prefs.getCharPref("version");
            var firstrun = httpsfinder.prefs.getBoolPref("firstrun");
            httpsfinder.debug = httpsfinder.prefs.getBoolPref("debugLogging");

            //Create whitelist database
            var file = Components.classes["@mozilla.org/file/directory_service;1"]
            .getService(Components.interfaces.nsIProperties)
            .get("ProfD", Components.interfaces.nsIFile);
            file.append("httpsfinder.sqlite");
            var storageService = Components.classes["@mozilla.org/storage/service;1"]
            .getService(Components.interfaces.mozIStorageService);
            var mDBConn = storageService.openDatabase(file); //Creates db on first run.
            mDBConn.createTable("whitelist", "id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL UNIQUE, rule STRING NOT NULL UNIQUE");

        }catch(e){
            //NS_ERROR_FAILURE is thrown when we try to recreate a table (May be too generic though...)
            //--Need to change sql command to 'If not exists' to avoid this.
            if(e.name != 'NS_ERROR_FAILURE')
                Components.utils.reportError("httpsfinder initialize error " + e + "\n");
        }
        finally{
            mDBConn.close();
            var currentVersion = httpsfinder.strings.getString("httpsfinder.version");
            if (firstrun){
                //First run code
                httpsfinder.prefs.setBoolPref("firstrun",false);
                httpsfinder.prefs.setCharPref("version", currentVersion);
            }
            else if (installedVersion != currentVersion && !firstrun){
                //Upgrade code
                httpsfinder.prefs.setCharPref("version",currentVersion);
                httpsfinder.browserOverlay.importWhitelist();
            }
            else //All other startup
                httpsfinder.browserOverlay.importWhitelist();
        }
    },

    //Auto-dismiss alert timers are started after the user clicks over to the given tab, so the
    //user doesn't miss background alerts that are dismissed before they switch to the tab.
    tabChanged: function(event){
        var browser = gBrowser.selectedBrowser;
        var alerts = ["httpsfinder-restart", "httpsfinder-ssl-enforced", "httpsfinder-https-found"];
        
        for(var i=0; i < alerts.length; i++){
            //Form 3 keys, one of each type for the given tab index (post-tab change index)
            var key = alerts[i] + gBrowser.getBrowserIndexForDocument(gBrowser.contentDocument);

            //If the tab contains that alert, set a timeout and removeNotification() for the auto-dismiss time.
            if (item = window.getBrowser().getNotificationBox(browser).getNotificationWithValue(key)){
                setTimeout(function(){
                    httpsfinder.browserOverlay.removeNotification(key)
                },httpsfinder.prefs.getIntPref("alertDismissTime") * 1000);
                return;
            }
        }
    },

    /*
    onPageLoad checks for any HTTPS redirect/detection activity for the tab. If there is something that the user needs to be alerted of,
    The notification is added. We can't add the notification directly from the detection callback, because page content still being loaded
    causes the notifications to be automatically dismissed from time to time. This is basically a method to slow down alerts until the page is ready.
     */
    onPageLoad: function(aEvent) {
        var brow = gBrowser.getBrowserForDocument(aEvent.originalTarget);
        var index = gBrowser.getBrowserIndexForDocument(aEvent.originalTarget);
        if(typeof httpsfinder.browserOverlay.redirectedTab[index] == "undefined" ||
            typeof httpsfinder.browserOverlay.redirectedTab[index][0] == "undefined" ||
            typeof httpsfinder.browserOverlay.redirectedTab[index][1] == "undefined" ||
            brow.currentURI.scheme != "https" || brow == null)
            return;

        var tabHost = brow.currentURI.host;
        var storedHost = httpsfinder.browserOverlay.redirectedTab[index][1].host;
        if(httpsfinder.browserOverlay.getHostWithoutSub(tabHost) != httpsfinder.browserOverlay.getHostWithoutSub(storedHost)){
            //Alert was for a previous tab and was not dismissed (page change timed just right before alert was cleared
            httpsfinder.browserOverlay.redirectedTab[index] = new Array();
            if(httpsfinder.debug)
                dump("httpsfinder resetting alert for tab - host mismatch on " + tabHost  +  " and "  + storedHost + "\n");
            return;
        }

        //If user was redirected - Redirected array holds at [x][0] a bool for whether or not the tab index has been redirected.
        //[x][1] holds a string hostname for the pre-redirect URL.  This is necessary because some sites like Google redirect to
        //encrypted.google.com when you use HTTPS.  We have to remember the old URL so it can be whitelisted from the alert drop down.
        if(httpsfinder.browserOverlay.redirectedTab[index][0]){
            if(!httpsfinder.prefs.getBoolPref("noruleprompt"))
                httpsfinder.browserOverlay.alertSSLEnforced(aEvent.originalTarget);
            httpsfinder.browserOverlay.redirectedTab[index][0] = false;
        }
    },

    //Return host without subdomain (e.g. input: code.google.com, outpout: google.com)
    getHostWithoutSub: function(fullHost){
        if(typeof fullHost != 'string')
            return "";
        else
            return fullHost.slice(fullHost.indexOf(".") + 1, fullHost.length);
    },

    importWhitelist: function(){
        //Can we get rid of these loops and just reset length? Test in Ubuntu**(wasn't working before without loops)
        for(var i=0; i <  httpsfinder.results.whitelist.length; i++)
            httpsfinder.results.whitelist[i] = "";
        httpsfinder.results.whitelist.length = 0;

        for(i=0; i <  httpsfinder.results.goodSSL.length; i++)
            httpsfinder.results.goodSSL[i] = "";
        httpsfinder.results.goodSSL.length = 0;

        for(i=0; i <  httpsfinder.results.tempNoAlerts.length; i++)
            httpsfinder.results.tempNoAlerts[i] = "";
        httpsfinder.results.tempNoAlerts.length = 0;

        try{
            var file = Components.classes["@mozilla.org/file/directory_service;1"]
            .getService(Components.interfaces.nsIProperties)
            .get("ProfD", Components.interfaces.nsIFile);
            file.append("httpsfinder.sqlite");
            var storageService = Components.classes["@mozilla.org/storage/service;1"]
            .getService(Components.interfaces.mozIStorageService);
            var mDBConn = storageService.openDatabase(file);
            var statement = mDBConn.createStatement("SELECT rule FROM whitelist");

            statement.executeAsync({
                handleResult: function(aResultSet){
                    for (let row = aResultSet.getNextRow(); row; row = aResultSet.getNextRow()){
                        httpsfinder.results.whitelist.push(row.getResultByName("rule"));
                    }
                },

                handleError: function(anError){
                    dump("httpsfinder whitelist database error " + anError.message + "\n");
                },

                handleCompletion: function(aReason){
                    //differentiate between permanent and temp whitelist items - permanent items are the first
                    // 'x' entries in the whitelist array. Temp items are added later as x+1....x+n
                    httpsfinder.results.permWhitelistLength = httpsfinder.results.whitelist.length; 
                    
                    if (aReason != Components.interfaces.mozIStorageStatementCallback.REASON_FINISHED)
                        dump("httpsfinder database error " + aReason.message + "\n");
                    else if(httpsfinder.prefs.getBoolPref("whitelistChanged"))
                        httpsfinder.prefs.setBoolPref("whitelistChanged", false);
                }
            });
        }
        catch(e){
            Components.utils.reportError("httpsfinder load whitelist " + e.name + "\n");
        }
        finally{
            statement.reset();
            mDBConn.asyncClose()
        }
    },

    //User clicked "Add to whitelist" from a drop down notification. Save to sqlite and whitelist array.
    whitelistDomain: function(hostIn){
        //Manually remove notification - in Ubuntu it stays up (no error is thrown)
        httpsfinder.browserOverlay.removeNotification('httpsfinder-https-found');
        httpsfinder.browserOverlay.removeNotification('httpsfinder-ssl-enforced');

        //If no host was passed, get it manually from stored values.
        if(typeof(hostIn) != "string"){
            var hostname;
            if(typeof httpsfinder.browserOverlay.redirectedTab[gBrowser.getBrowserIndexForDocument(gBrowser.contentDocument)] != "undefined" &&
                typeof httpsfinder.browserOverlay.redirectedTab[gBrowser.getBrowserIndexForDocument(gBrowser.contentDocument)][1] != "undefined" )
                hostname = httpsfinder.browserOverlay.redirectedTab[gBrowser.getBrowserIndexForDocument(gBrowser.contentDocument)][1].host.toLowerCase();
            else
                hostname = gBrowser.currentURI.host.toLowerCase();

            //Bug workaround.  If user closes tab in the middle of open tabs, the indexes are shifted.  The only time we can't just use currentURI
            //is when the https:// page forwards to a subdomain.  This is rare.  With the for loop below, this bug can still happen, but only under the following conditions:
            //1) Auto forward enabled. 2)User browsed to a site where HTTPS forwards to a different hostname 3)conditions 1 and 2 are done in a background tab
            //4) Some tab before the above tab is closed, then user switches to the target tab and clicks "Add to whitelist".  This is unlikely enough that I'm leaving
            //it in for now.  Will look for a better way to do this than the redirectedTab array.
            for(var i=0; i<httpsfinder.browserOverlay.redirectedTab.length; i++){
                if(typeof httpsfinder.browserOverlay.redirectedTab[i] == "undefined" || typeof httpsfinder.browserOverlay.redirectedTab[i][1] == "undefined")
                    hostname = hostname; //do nothing
                else if(httpsfinder.browserOverlay.redirectedTab[i][1].host.toLowerCase() == gBrowser.currentURI.host.toLowerCase())
                    hostname = gBrowser.currentURI.host.toLowerCase();
            }
        }
        else if(typeof(hostIn) == "string")
            hostname = hostIn;

        try{
            var file = Components.classes["@mozilla.org/file/directory_service;1"]
            .getService(Components.interfaces.nsIProperties)
            .get("ProfD", Components.interfaces.nsIFile);
            file.append("httpsfinder.sqlite");
            var storageService = Components.classes["@mozilla.org/storage/service;1"]
            .getService(Components.interfaces.mozIStorageService);
            var mDBConn = storageService.openDatabase(file);

            var statement = mDBConn.createStatement("INSERT INTO whitelist (rule) VALUES (?1)");
            statement.bindStringParameter(0, hostname);
            statement.executeAsync({
                handleResult: function(aResultSet){},

                handleError: function(anError){
                    alert("Error adding rule: " + anError.message);
                    dump("httpsfinder whitelist rule add error " + anError.message + "\n");
                },
                handleCompletion: function(aReason){
                    if (aReason == Components.interfaces.mozIStorageStatementCallback.REASON_FINISHED)
                        if(!httpsfinder.browserOverlay.isWhitelisted(hostname)){
                            httpsfinder.results.whitelist.push(hostname);
                        }
                }
            });
        }
        catch(e){
            Components.utils.reportError("httpsfinder addToWhitelist " + e.name + "\n");
        }
        finally{
            statement.reset();
            mDBConn.asyncClose()
        }
    },

    //Alert after HTTPS was auto-enforced on a page
    alertSSLEnforced: function(aDocument){
        var browser = gBrowser.getBrowserForDocument(aDocument);

        //Return if a rule has already been saved this session (we just silently enforce)
        if(httpsfinder.results.tempNoAlerts.indexOf(browser.currentURI.host) != -1)
            return;

        //Append alert if 'noruleeprompt' pref is not enabled, and host is not "". (addon manager, blank page, etc)
        else if(!httpsfinder.prefs.getBoolPref("noruleprompt") && gBrowser.currentURI.host != ""){

            var nb = gBrowser.getNotificationBox(gBrowser.getBrowserForDocument(aDocument));
            var saveRuleButtons = [{
                label: httpsfinder.strings.getString("httpsfinder.main.whitelist"),
                accessKey: httpsfinder.strings.getString("httpsfinder.main.whitelistKey"),
                popup: null,
                callback: httpsfinder.browserOverlay.whitelistDomain
            },{
                label: httpsfinder.strings.getString("httpsfinder.main.noThanks"),
                accessKey: httpsfinder.strings.getString("httpsfinder.main.noThanksKey"),
                popup: null,
                callback: httpsfinder.browserOverlay.redirectNotNow
            },{
                label: httpsfinder.strings.getString("httpsfinder.main.rememberSetting"),
                accessKey: httpsfinder.strings.getString("httpsfinder.main.rememberSettingKey"),
                popup: null,
                callback: httpsfinder.browserOverlay.writeRule
            }];

            //Key used for alert timeouts - format is "keytype" + tabIndex (e.g. "httpsfinder-ssl-enforced2")
            var key = "httpsfinder-ssl-enforced" + gBrowser.getBrowserIndexForDocument(aDocument);

            if(httpsfinder.prefs.getBoolPref("autoforward"))
                nb.appendNotification(httpsfinder.strings.getString("httpsfinder.main.autoForwardRulePrompt"),
                    key, 'chrome://httpsfinder/skin/httpsAvailable.png',
                    nb.PRIORITY_INFO_LOW, saveRuleButtons);
            else
                nb.appendNotification(httpsfinder.strings.getString("httpsfinder.main.saveRulePrompt"),
                    key, 'chrome://httpsfinder/skin/httpsAvailable.png',
                    nb.PRIORITY_INFO_LOW, saveRuleButtons);

            if(httpsfinder.prefs.getBoolPref("dismissAlerts"))
                setTimeout(function(){
                    httpsfinder.browserOverlay.removeNotification(key)
                },httpsfinder.prefs.getIntPref("alertDismissTime") * 1000, 'httpsfinder-ssl-enforced');
        }
    },

    //Check if host is whitelisted. Checks permanently whitelisted items and session items.
    isWhitelisted: function(host){
        for(var i=0; i < httpsfinder.results.whitelist.length; i++){
            var whitelistItem = httpsfinder.results.whitelist[i];
            if(whitelistItem == host)
                return true;

            //If rule starts with *., check the end of the hostname (i.e. for *.google.com, check for host ending in .google.com
            else if(whitelistItem.substr(0,2) == "*.")
                //Delete * from rule, compare to last "rule length" chars of the hostname
                if(whitelistItem.replace("*","") == host.substr(host.length -
                    whitelistItem.length + 1,host.length))
                    return true;
        }
        return false;
    },

    //Save rule for HTTPS Everywhere. Working on moving this to JSM.
    writeRule: function(){
        var eTLDService = Components.classes["@mozilla.org/network/effective-tld-service;1"]
        .getService(Components.interfaces.nsIEffectiveTLDService);
        try{
            var topLevel = "." + eTLDService.getPublicSuffix(httpsfinder.browserOverlay.redirectedTab[gBrowser.getBrowserIndexForDocument(gBrowser.contentDocument)][1]);
            var hostname = httpsfinder.browserOverlay.redirectedTab[gBrowser.getBrowserIndexForDocument(gBrowser.contentDocument)][1].host.toLowerCase();
        }
        catch(e){
            hostname = gBrowser.currentURI.host.toLowerCase();
            topLevel =  "." + eTLDService.getPublicSuffixFromHost(hostname);
        }
        var title = "";

        for(var i=0; i<httpsfinder.browserOverlay.redirectedTab.length; i++){
            if(typeof httpsfinder.browserOverlay.redirectedTab[i] == "undefined" ||
                typeof httpsfinder.browserOverlay.redirectedTab[i][1] == "undefined"){
            // return;do nothing
            }
            else if(httpsfinder.browserOverlay.redirectedTab[i][1].host.toLowerCase() ==
                gBrowser.currentURI.host.toLowerCase())
                hostname = gBrowser.currentURI.host.toLowerCase();
            topLevel =  "." + eTLDService.getPublicSuffixFromHost(hostname);
        }

        var tldLength = topLevel.length - 1;

        if(hostname.indexOf("www.") != -1)
            title = hostname.slice(hostname.indexOf(".",0) + 1,hostname.lastIndexOf(".",0) - tldLength);
        else
            title = hostname.slice(0, hostname.lastIndexOf(".", 0) - tldLength);
        title = title.charAt(0).toUpperCase() + title.slice(1);

        var rule;
        if(hostname == "localhost"){
            title = "Localhost";
            rule = "<ruleset name=\""+ title + "\">" + "\n" +
            "<target host=\"" + hostname + "\" />" +
            "<rule from=\"^http://(www\\.)?" + title.toLowerCase() +
            "\\" +"/\"" +" to=\"https://" + title.toLowerCase() +
            "/\"/>" + "\n" + "</ruleset>";
        }

        else{
            rule = "<ruleset name=\""+ title + "\">" + "\n"
            + "\t" + "<target host=\"" + hostname + "\" />" + "\n";

            //Check hostname for "www.".
            //One will be "domain.com" and the other will be "www.domain.com"
            var targetHost2 = "";
            if(hostname.indexOf("www.") != -1){
                targetHost2 = httpsfinder.browserOverlay.getHostWithoutSub(hostname);
                rule = rule + "\t" + "<target host=\"" + targetHost2 +"\" />" + "\n" +
                "\t" + "<rule from=\"^http://(www\\.)?" + title.toLowerCase() +
                "\\" + topLevel +"/\"" +" to=\"https://www." + title.toLowerCase() +
                topLevel + "/\"/>" + "\n" + "</ruleset>";
            }
            else{
                domains = hostname.split(".");
                if(domains.length == 2){
                    targetHost2 = "www." + hostname;
                    rule = rule + "\t" + "<target host=\"" + targetHost2 +"\" />" +
                    "\n" + "\t" + "<rule from=\"^http://(www\\.)?" + title.toLowerCase() +
                    "\\" + topLevel +"/\"" +" to=\"https://" + title.toLowerCase() +
                    topLevel + "/\"/>" + "\n" + "</ruleset>";
                }
                //If hostname includes non-www subdomain, we don't include www in our rule.
                else
                    rule = rule + "\t" + "<rule from=\"^http://(www\\.)?" +
                    title.toLowerCase() + "\\" + topLevel +"/\"" +" to=\"https://"
                    + title.toLowerCase() + topLevel + "/\"/>" + "\n" + "</ruleset>";
            }
        }

        rule = rule + "\n" + "<!-- Rule generated by HTTPS Finder " +
        httpsfinder.strings.getString("httpsfinder.version") +
        " -->"

        if(httpsfinder.prefs.getBoolPref("showrulepreview")){
            var params = {
                inn:{
                    rule:rule
                },
                out:null
            };
            window.openDialog("chrome://httpsfinder/content/rulePreview.xul", "",
                "chrome, dialog, modal,centerscreen, resizable=yes", params).focus();
            if (!params.out){
                httpsfinder.browserOverlay.removeNotification('httpsfinder-getHE');
                return; //user canceled rule
            }
            else
                rule = params.out.rule; //reassign rule value from the textbox
        }

        //Synchronous for FF3.5
        var foStream = Components.classes["@mozilla.org/network/file-output-stream;1"].
        createInstance(Components.interfaces.nsIFileOutputStream);

        var file = Components.classes["@mozilla.org/file/directory_service;1"].
        getService(Components.interfaces.nsIProperties).
        get("ProfD", Components.interfaces.nsIFile);
        file.append("HTTPSEverywhereUserRules")
        file.append(title + ".xml");
        try{
            file.create(Components.interfaces.nsIFile.NORMAL_FILE_TYPE, 0666);
        }
        catch(e){
            if(e.name == 'NS_ERROR_FILE_ALREADY_EXISTS')
                file.remove(false);
        }
        foStream.init(file, 0x02 | 0x08 | 0x20, 0666, 0);
        var converter = Components.classes["@mozilla.org/intl/converter-output-stream;1"].
        createInstance(Components.interfaces.nsIConverterOutputStream);
        converter.init(foStream, "UTF-8", 0, 0);
        converter.writeString(rule);
        converter.close();

        if(httpsfinder.results.tempNoAlerts.indexOf(hostname) == -1)
            httpsfinder.results.tempNoAlerts.push(hostname);
        
        httpsfinder.browserOverlay.alertRuleFinished(gBrowser.contentDocument);
    },

    restartNow: function(){
        Application.restart();
    },

    //Callback after rule file is saved
    alertRuleFinished: function(aDocument){
        //Check firefox version and use appropriate method
        if(Application.version.charAt(0) >= 4){
            Components.utils.import("resource://gre/modules/AddonManager.jsm");
            AddonManager.getAddonByID("https-everywhere@eff.org", function(addon) {
                //Addon is null if not installed
                if(addon == null)
                    getHTTPSEverywhere();
                else if(addon != null)
                    promptForRestart();
            });
        }
        else{  //Firefox versions below 4.0
            if(!Application.extensions.has("https-everywhere@eff.org"))
                getHTTPSEverywhere();
            else
                promptForRestart();
        }

        //Callback - alert user to install HTTPS Everywhere for rule enforcement
        var getHTTPSEverywhere = function() {
            var installButtons = [{
                label: httpsfinder.strings.getString("httpsfinder.main.getHttpsEverywhere"),
                accessKey: httpsfinder.strings.getString("httpsfinder.main.getHttpsEverywhereKey"),
                popup: null,
                callback: getHE  //Why is this needed? Setting the callback directly automatically calls when there is a parameter
            }];
            var nb = gBrowser.getNotificationBox(gBrowser.getBrowserForDocument(aDocument));
            nb.appendNotification(httpsfinder.strings.getString("httpsfinder.main.NoHttpsEverywhere"),
                'httpsfinder-getHE','chrome://httpsfinder/skin/httpsAvailable.png',
                nb.PRIORITY_INFO_LOW, installButtons);
        };

        //See previous comment (in installButtons - callback: getHE)
        var getHE = function(){
            httpsfinder.openWebsiteInTab("http://www.eff.org/https-everywhere/");
        };

        //Callback - HTTPS Everywhere is installed. Prompt for restart
        var promptForRestart = function() {
            var nb = gBrowser.getNotificationBox(gBrowser.getBrowserForDocument(aDocument));
            var pbs = Components.classes["@mozilla.org/privatebrowsing;1"]
            .getService(Components.interfaces.nsIPrivateBrowsingService);
            
            var key = "httpsfinder-restart" + gBrowser.getBrowserIndexForDocument(gBrowser.contentDocument);

            var restartButtons = [{
                label: httpsfinder.strings.getString("httpsfinder.main.restartYes"),
                accessKey: httpsfinder.strings.getString("httpsfinder.main.restartYesKey"),
                popup: null,
                callback: httpsfinder.browserOverlay.restartNow
            }];

            if (!pbs.privateBrowsingEnabled)
                nb.appendNotification(httpsfinder.strings.getString("httpsfinder.main.restartPrompt"),
                    key,'chrome://httpsfinder/skin/httpsAvailable.png',
                    nb.PRIORITY_INFO_LOW, restartButtons);
            else
                nb.appendNotification(httpsfinder.strings.getString("httpsfinder.main.restartPromptPrivate"),
                    key,'chrome://httpsfinder/skin/httpsAvailable.png',
                    nb.PRIORITY_INFO_LOW, restartButtons);

            if(httpsfinder.prefs.getBoolPref("dismissAlerts"))
                setTimeout(function(){
                    httpsfinder.browserOverlay.removeNotification(key)
                },httpsfinder.prefs.getIntPref("alertDismissTime") * 1000, 'httpsfinder-restart');
        };
    },

    //Remove notification called from setTimeout(). Looks through each tab for an alert with mataching key. Removes it, if exists.
    removeNotification: function(key)
    {
        //key is a formatted as alert type (e.g. "httpsfinder-restart"), with the tab index concatinated to the end, httpsfinder-restart2).
        var browsers = gBrowser.browsers;
        for (var i = 0; i < browsers.length; i++)
            if (item = window.getBrowser().getNotificationBox(browsers[i]).getNotificationWithValue(key))
                if(i == gBrowser.getBrowserIndexForDocument(gBrowser.contentDocument))
                    window.getBrowser().getNotificationBox(browsers[i]).removeNotification(item);                
    },

    //Adds to session whitlelist (not database)
    redirectNotNow: function() {
        var hostname = "";
        if(typeof httpsfinder.browserOverlay.redirectedTab[gBrowser.getBrowserIndexForDocument(gBrowser.contentDocument)] != "undefined" &&
            typeof httpsfinder.browserOverlay.redirectedTab[gBrowser.getBrowserIndexForDocument(gBrowser.contentDocument)][1] != "undefined" )
            hostname = httpsfinder.browserOverlay.redirectedTab[gBrowser.getBrowserIndexForDocument(gBrowser.contentDocument)][1].host.toLowerCase();
        else
            hostname = gBrowser.currentURI.host.toLowerCase();

        //Bug workaround.  If user closes tab in the middle of open tabs, the indexes are shifted.  The only time we can't just use currentURI
        //is when the https:// page forwards to a subdomain.  This is rare.  With the for loop below, this bug can still happen, but only under the following conditions:
        //1) Auto forward enabled. 2)User browsed to a site where HTTPS forwards to a different hostname 3)conditions 1 and 2 are done in a background tab
        //4) Some tab before the above tab is closed, then user switches to the target tab and clicks "Add to whitelist".  This is unlikely enough that I'm leaving
        //it in for now.  Will look for a better way to do this than the redirectedTab array.
        for(var i=0; i<httpsfinder.browserOverlay.redirectedTab.length; i++){
            if(typeof httpsfinder.browserOverlay.redirectedTab[i] == "undefined" ||
                typeof httpsfinder.browserOverlay.redirectedTab[i][1] == "undefined")
                hostname = hostname; //do nothing
            else if(httpsfinder.browserOverlay.redirectedTab[i][1].host.toLowerCase() ==
                gBrowser.currentURI.host.toLowerCase())
                hostname = gBrowser.currentURI.host.toLowerCase();
        }
        if(!httpsfinder.browserOverlay.isWhitelisted(hostname))
            httpsfinder.results.whitelist.push(hostname);
    },

    //Auto-redirect to https
    redirectAuto: function(aBrowser, request){
        var sinceLastReset = Date.now() - httpsfinder.browserOverlay.lastRecentReset;
        var index = gBrowser.getBrowserIndexForDocument(aBrowser.contentDocument);
        var requestURL = request.URI.asciiSpec.replace("http://", "https://");
        var host = request.URI.host.toLowerCase();

        var redirectLoop = false;
        ///Need to determine if link was clicked, or if reload is automatic
        if(sinceLastReset < 2500 && sinceLastReset > 200){
            for(var i=0; i<httpsfinder.browserOverlay.recent.length; i++){
                if(httpsfinder.browserOverlay.recent[i][0] == host && httpsfinder.browserOverlay.recent[i][1] == index){
                    if(!httpsfinder.browserOverlay.isWhitelisted(host))
                        httpsfinder.results.whitelist.push(host);
                        
                    dump("httpsfinder redirect loop detected on host " + host + ". Host temporarily whitelisted. Reload time: " + sinceLastReset + "ms\n");
                    redirectLoop = true;
                }
            }
            httpsfinder.browserOverlay.recent.length = 0;
        }

        if(httpsfinder.detect.hostsMatch(aBrowser.contentDocument.baseURIObject.host.toLowerCase(),host) && !redirectLoop){
            aBrowser.loadURIWithFlags(requestURL, nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY);
            httpsfinder.browserOverlay.redirectedTab[index] = new Array();
            httpsfinder.browserOverlay.redirectedTab[index][0] = true;
            httpsfinder.browserOverlay.redirectedTab[index][1] = aBrowser.currentURI;

            httpsfinder.browserOverlay.removeFromWhitelist(aBrowser.contentDocument, request.URI.host.toLowerCase());
        }
        else{
            if(httpsfinder.debug && !redirectLoop)
                dump("Host mismatch, forward blocked (Document: " +
                    aBrowser.contentDocument.baseURIObject.host.toLowerCase() +
                    " , Detection host: " + host + "\n");
        }

        httpsfinder.browserOverlay.recent.push([host,index]);
        httpsfinder.browserOverlay.lastRecentReset = Date.now();
    },

    //Manual redirect (user clicked "Yes, go HTTPS")
    redirect: function() {
        var aDocument = gBrowser.contentDocument;
        httpsfinder.browserOverlay.redirectedTab[gBrowser.getBrowserIndexForDocument(aDocument)] = new Array();
        httpsfinder.browserOverlay.redirectedTab[gBrowser.getBrowserIndexForDocument(aDocument)][0] = true;

        var ioService = Components.classes["@mozilla.org/network/io-service;1"]
        .getService(Components.interfaces.nsIIOService);

        var uri = gBrowser.getBrowserForDocument(aDocument).currentURI.asciiSpec;
        uri = uri.replace("http://", "https://");

        httpsfinder.browserOverlay.redirectedTab[gBrowser.getBrowserIndexForDocument(aDocument)][1] = ioService.newURI(uri, null, null);
        window.content.wrappedJSObject.location = uri;
    },

    // Removes item from the session whitelist array. This is messy and needs to be fixed.
    // Runes three ways and is called from multiple functions.
    removeFromWhitelist: function(aDocument, host){
        // Check for passed in hostname (if calling function called removeFromWhitelist(null, "xxxxxx.com")
        if(!aDocument && host)
            for(let i=0; i<httpsfinder.results.whitelist.length; i++){
                if(httpsfinder.results.whitelist[i] == host){
                    httpsfinder.results.whitelist.splice(i,1);
                    if(httpsfinder.debug)
                        dump("httpsfinder removing " + httpsfinder.results.whitelist[i] + " from whitelist\n");
                }
            }

        // Else, if called as removeFromWhitelist(tab.contentDocument, null) - get the host and remove that from the whitelist
        else if(aDocument && !host){
            var preRedirectHost = gBrowser.getBrowserForDocument(aDocument).currentURI.host;
            for(let i=0; i<httpsfinder.results.whitelist.length; i++){
                if(httpsfinder.results.whitelist[i] == preRedirectHost.slice((preRedirectHost.length - httpsfinder.results.whitelist[i].length),preRedirectHost.length)){
                    httpsfinder.results.whitelist.splice(i,1);
                    if(httpsfinder.debug)
                        dump("httpsfinder removing " + httpsfinder.results.whitelist[i] + " from whitelist.\n");
                   
                }
            }
        }

        // Catch for any thing that slipped through... Why is this needed? Maybe if "gBrowser.getBrowserForDocument(aDocument).currentURI.host" (above) fails?
        else
            for(var i=0; i<httpsfinder.results.whitelist.length; i++)
                if(i > httpsfinder.browserOverlay.permWhitelistLength - 1 &&
                    httpsfinder.browserOverlay.getHostWithoutSub(httpsfinder.results.whitelist[i]) == httpsfinder.browserOverlay.getHostWithoutSub(host)){
                    httpsfinder.results.whitelist.splice(i,1);
                    if(httpsfinder.debug)
                        dump("httpsfinder removing " + httpsfinder.results.whitelist[i] + " from whitelist..\n");
                }
    },

    //User clicked "Clear Session Whitelist" - Reset good and bad cached results, as well as user temporary whitelist.
    resetWhitelist: function(){
        httpsfinder.popupNotify("HTTPS Finder", httpsfinder.strings.getString("httpsfinder.overlay.whitelistReset"));

        //Fires re-import of whitelist through observer - Need to remove this since the whitelist is now in JSM (can call directly)
        httpsfinder.prefs.setBoolPref("whitelistChanged", true);

        httpsfinder.results.goodSSL.length = 0;
        httpsfinder.results.goodSSL = [];
        httpsfinder.results.whitelist.length = 0;
        httpsfinder.results.whitelist = [];
        httpsfinder.results.permWhitelistLength = 0;
    },

    //Preference observer
    observe: function(subject, topic, data){
        if (topic != "nsPref:changed")
            return;

        switch(data){
            //Reimport whitelist if user added or removed item
            case "whitelistChanged":
                httpsfinder.browserOverlay.importWhitelist();
                break;
            
            //Remove/add window listener if httpsfinder is enabled or disabled
            case "enable":
                var appcontent = document.getElementById("appcontent");
                if(!httpsfinder.prefs.getBoolPref("enable")){
                    window.removeEventListener("load", function() {
                        httpsfinder.browserOverlay.init();
                    }, false);
                    httpsfinder.detect.unregister();
                    if(appcontent)
                        appcontent.removeEventListener("DOMContentLoaded", httpsfinder.browserOverlay.onPageLoad, true);
                }
                else if(httpsfinder.prefs.getBoolPref("enable"))
                    httpsfinder.browserOverlay.init();
                break;

            case "debugLogging":
                httpsfinder.debug = httpsfinder.prefs.getBoolPref("debugLogging");
                break;

            case "dismissAlerts":
                var container = gBrowser.tabContainer;

                if(httpsfinder.prefs.getBoolPref("dismissAlerts"))
                    container.addEventListener("TabSelect", httpsfinder.browserOverlay.tabChanged, false);
                else
                    container.removeEventListener("TabSelect", httpsfinder.browserOverlay.tabChanged, false);
                break;
        }
    },

    //Window is shutting down - remove listeners/observers
    shutdown: function(){
        try{
            httpsfinder.prefs.removeObserver("", this);
            httpsfinder.detect.unregister();
        }
        catch(e){ /*do nothing - it is already removed if the extension was disabled*/ }

        try{
            var appcontent = document.getElementById("appcontent");
            if(appcontent)
                appcontent.removeEventListener("DOMContentLoaded", httpsfinder.browserOverlay.onPageLoad, true);
        }
        catch(e){ /*appcontent may be null*/ }

        window.removeEventListener("unload", function(){
            httpsfinder.browserOverlay.shutdown();
        }, false);

        window.removeEventListener("load", function(){
            httpsfinder.browserOverlay.init();
        }, false);

        var container = gBrowser.tabContainer;
        container.removeEventListener("TabSelect", httpsfinder.browserOverlay.tabChanged, false);
    }
};

window.addEventListener("load", function(){
    httpsfinder.browserOverlay.init();
}, false);

window.addEventListener("unload", function(){
    httpsfinder.browserOverlay.shutdown();
}, false);