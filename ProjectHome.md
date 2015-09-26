## What is HTTPS Finder? ##
HTTPS Finder automatically detects and enforces valid HTTPS connections as you browse, as well as automating the rule creation process for HTTPS-Everywhere (instead of having to manually type "https://" in the address bar to test, and writing your own XML rule for it).

The extension sends a small HTTPS request to each HTTP page you browse to. If there is a response, the certificate is checked for validity (any certificate errors will result in no notification, and no further detection requests during that session). If valid, HTTPS is automatically enforced (can be disabled for an alert only, with no redirect), and the user is given an option to save the auto-generated rule for HTTPS Everywhere. It is recommended to create rules whenever possible, as it more securely enforces secure connections.

Try out the newest version [here.](https://code.google.com/p/https-finder/downloads/list)

[Submit](https://code.google.com/p/https-finder/issues/entry) a Bug report/feature request


### Source moved to Github ###
I've moved the repository to Github. Find the newest source code here: https://github.com/kevinjacobs/HTTPS-Finder. New version downloads and issue tracking will remain here on Google Code.


### SECURITY NOTE: ###
HTTPS Finder begins looking for an SSL connection as soon as you click a link or start navigating to a new HTTP page. Because an HTTP connection is established first, your session cookie can still be sent unencrypted before going to HTTPS. This may not fully protect you against Firesheep or other man-in-the-middle attacks, but it minimizes the chances of it happening.

HTTPS Finder only detects valid responses with good certificates. It does not guarantee a secure SSL implementation on the server side.

HTTPS Finder is most powerful when used side-by-side with HTTPS Everywhere to create rule sets tailored to your browsing habits. Used alone it's better than nothing but it's important to realize that limitation.