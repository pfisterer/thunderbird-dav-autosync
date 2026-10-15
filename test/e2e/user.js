// Preferences for the test profiles, kept separate from any production Thunderbird.
user_pref("mail.shell.checkDefaultClient", false);
user_pref("mailnews.start_page.enabled", false);
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.experiments.enabled", true);
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.debugger.prompt-connection", false);
// Console output of add-on pages to stdout (captured by the e2e test)
user_pref("devtools.console.stdout.content", true);
user_pref("devtools.console.stdout.chrome", true);
