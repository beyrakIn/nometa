const Sentry = require("@sentry/node");

Sentry.init({
  dsn: "https://ae156d9ea8d8a85eff4d5db917093ce0@o4510863543828480.ingest.de.sentry.io/4510863560998992",
  sendDefaultPii: true,
});
