// Hosts that request blocking must never touch, and the URL patterns that express host rules.
//
// A rule "example.com" covers example.com and every subdomain; "www.google.com/recaptcha" covers
// exactly that host under a path prefix. These lists are allow-lists: they are put in front of every
// Network.setBlockedURLs pattern list (block:false wins, first match), they are removed from the
// filter engine, and Tier B never fails a request to them.

/** CAPTCHA, anti-bot and challenge providers: blocking them turns a solvable page into a dead end. */
export const CHALLENGE_HOSTS = [
  "challenges.cloudflare.com",
  "recaptcha.net",
  "www.google.com/recaptcha",
  "www.gstatic.com/recaptcha",
  "hcaptcha.com",
  "arkoselabs.com",
  "funcaptcha.com",
  "captcha-delivery.com",
  "datadome.co",
  "perimeterx.net",
  "px-cdn.net",
  "px-cloud.net",
  "px-client.net",
  "pxchk.net",
  "awswaf.com",
  "geetest.com",
  "geevisit.com",
  "friendlycaptcha.com",
  "frcapi.com",
  "mtcaptcha.com",
];

/** Payment pages and their fraud checks. */
export const PAYMENT_HOSTS = [
  "stripe.com",
  "stripe.network",
  "paypal.com",
  "paypalobjects.com",
  "braintreegateway.com",
  "braintree-api.com",
  "adyen.com",
  "adyenpayments.com",
  "cardinalcommerce.com",
  "klarna.com",
  "klarnaservices.com",
  "checkout.com",
  "squareup.com",
  "squarecdn.com",
  "pay.google.com",
  "payments.google.com",
  "authorize.net",
];

/** Sign-in and SSO providers. */
export const AUTH_HOSTS = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.microsoft.com",
  "login.live.com",
  "appleid.apple.com",
  "appleid.cdn-apple.com",
  "okta.com",
  "oktacdn.com",
  "auth0.com",
  "onelogin.com",
  "duosecurity.com",
];

/**
 * Consent managers. Blocking their scripts (as EasyList Cookie does) hides nothing reliably and
 * stops autoconsent from answering the banner, so they always load.
 */
export const CMP_HOSTS = [
  "cookielaw.org",
  "onetrust.com",
  "cookiepro.com",
  "cookiebot.com",
  "cookiebot.eu",
  "usercentrics.eu",
  "usercentrics.com",
  "privacy-center.org",
  "didomi.io",
  "consentmanager.net",
  "consensu.org",
  "privacy-mgmt.com",
  "sp-prod.net",
  "fundingchoicesmessages.google.com",
  "osano.com",
  "cookieyes.com",
  "cdn-cookieyes.com",
  "cmp.quantcast.com",
  "trustarc.com",
  "consent.truste.com",
  "iubenda.com",
  "termly.io",
  "cookie-script.com",
  "cookiefirst.com",
  "axept.io",
  "cookiehub.eu",
  "cookiehub.net",
  "civiccomputing.com",
  "consentframework.com",
  "ketchcdn.com",
  "transcend-cdn.com",
  "evidon.com",
  "uniconsent.com",
];

/** Subscription and paywall vendors: blocking them would circumvent a paywall. */
export const PAYWALL_HOSTS = [
  "piano.io",
  "tinypass.com",
  "poool.fr",
  "zephr.com",
  "laterpay.net",
  "pelcro.com",
  "memberful.com",
  "evolok.net",
  "steadyhq.com",
  "qiota.com",
];

/** Every host rule that request blocking must leave alone. */
export const NEVER_BLOCK: readonly string[] = [...CHALLENGE_HOSTS, ...PAYMENT_HOSTS, ...AUTH_HOSTS, ...CMP_HOSTS, ...PAYWALL_HOSTS];

/**
 * Anti-bot sensors served first-party, from the site's own host or a custom subdomain, so no host rule
 * above covers them. The lists do block some (checked offline against the cached EasyList/EasyPrivacy/
 * uBO engine, Oct 2026): the generic `/api/v2/collector` rule hits HUMAN's `/<appId>/xhr/api/v2/collector`,
 * `/akam/13/` and `/akam/.../pixel_` hit Akamai Bot Manager, a site rule hits one site's `/px/<appId>/init.js`,
 * and DataDome's `dd.<site>` endpoints and HUMAN's `collector-px<appId>.<site>` are listed whole. A sensor
 * that cannot report scores the session as a bot, so a blocked one turns a passable site into a challenge.
 */
export const SENSOR_PATHS: readonly RegExp[] = [
  // HUMAN (PerimeterX) first-party: the app id's 8 characters (always with a digit), optionally after /px/ and "PX".
  /^(?:\/px)?\/(?:px)?(?=[a-z]*\d)[a-z0-9]{8}\/(?:init\.js|xhr\/|captcha\/|captcha\.js)/i,
  /^\/akam\/\d+\//, // Akamai Bot Manager sensor script and pixel
  /^\/_bm\//, // Akamai Bot Manager sensor data
  /^\/_sec\//, // Akamai challenge (sec-cpt)
  /^\/_Incapsula_Resource/, // Imperva
  /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:ips\.js|fp|tl)/, // Kasada
  /^\/cdn-cgi\/challenge-platform\//, // Cloudflare bot management and challenges
];

/** Sensor endpoints on a site's own custom subdomain: DataDome's `dd.<site>`, HUMAN's `collector-px<appId>.<site>`. */
export const SENSOR_HOST = /^(?:dd|collector-px[a-z0-9]+)\./i;

/** True when `url` is a first-party anti-bot sensor request (see SENSOR_PATHS). */
export function isSensorRequest(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return sensorUrl(u);
}

function sensorUrl(u: URL): boolean {
  return SENSOR_HOST.test(u.hostname) || SENSOR_PATHS.some((re) => re.test(u.pathname));
}

/** Cosmetic selectors that would hide a consent banner (autoconsent must see it) or a paywall. */
export const PROTECTED_SELECTOR =
  /cookie|consent|gdpr|ccpa|onetrust|optanon|didomi|cybot|usercentrics|qc-cmp|sp_message|sp-message|fc-consent|fc-dialog|osano|cky-|truste|cmpbox|cmp-|_cmp|privacy-?(banner|notice|popup|overlay)|paywall|pay-wall|regwall|reg-wall|metered|piano|tp-modal|tp-backdrop|tp-container|tp-iframe|poool|zephr|pelcro|laterpay|leaky|subscriber-only|subscription-wall|article-gate|content-gate|login-?wall/i;

/** URL fragments of consent-manager and paywall scripts, for rules that carry no hostname. */
export const PROTECTED_URL =
  /cookie.?(law|consent|bot|script|yes|first|notice|banner|pro|hub)|consent|onetrust|optanon|usercentrics|didomi|privacy-?center|privacy-mgmt|trustarc|truste|osano|iubenda|termly|axept|klaro|borlabs|complianz|fundingchoices|gdpr|\/cmp|cmp\.|\btcf|paywall|piano|tinypass|poool|zephr|laterpay|pelcro|memberful|evolok|regwall|metering/i;

function splitRule(rule: string): { host: string; path?: string } {
  const i = rule.indexOf("/");
  return i < 0 ? { host: rule } : { host: rule.slice(0, i), path: rule.slice(i) };
}

/** True when `host` is `ruleHost` or one of its subdomains. */
export function hostIsUnder(host: string, ruleHost: string): boolean {
  return host === ruleHost || host.endsWith("." + ruleHost);
}

/** True when a request to `url` must never be blocked. The full allow-list (the default) also covers first-party sensors. */
export function isNeverBlocked(url: string, rules: readonly string[] = NEVER_BLOCK): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (rules === NEVER_BLOCK && sensorUrl(u)) return true;
  const host = u.hostname.toLowerCase();
  for (const r of rules) {
    const { host: h, path } = splitRule(r);
    if (path ? host === h && u.pathname.startsWith(path) : hostIsUnder(host, h)) return true;
  }
  return false;
}

/**
 * True when blocking `host` wholesale could hit a protected rule (the host is under one, or one is under
 * it). Under the full allow-list (the default), a first-party sensor subdomain counts too.
 */
export function hostTouchesProtected(host: string, rules: readonly string[] = NEVER_BLOCK): boolean {
  if (rules === NEVER_BLOCK && SENSOR_HOST.test(host)) return true;
  for (const r of rules) {
    const { host: h } = splitRule(r);
    if (hostIsUnder(host, h) || hostIsUnder(h, host)) return true;
  }
  return false;
}

/** Known consent-manager request: used to decide whether waiting for consent is worthwhile. */
export function isCmpRequest(url: string): boolean {
  return isNeverBlocked(url, CMP_HOSTS);
}

const HOST_RE = /^[a-z0-9.-]+$/;

/** URLPattern (Chrome 13x+ `urlPatterns`) for a host and its subdomains, any scheme and port. */
export function hostUrlPattern(host: string): string {
  if (!HOST_RE.test(host)) throw new Error(`not a plain hostname: ${host}`);
  return `*://{*.}?${host}:*/*`;
}

/** URLPattern for a protected rule (host with subdomains, or exact host plus path prefix). */
export function ruleUrlPattern(rule: string): string {
  const { host, path } = splitRule(rule);
  if (!path) return hostUrlPattern(host);
  if (!HOST_RE.test(host)) throw new Error(`not a plain hostname: ${host}`);
  return `*://${host}:*${path}*`;
}

/**
 * Legacy wildcard `urls` (older Chrome): no allow entries and no port wildcard, and `*` also
 * spans query strings, so a URL that merely mentions a blocked host in its query is blocked too.
 */
export function hostLegacyPatterns(host: string): string[] {
  if (!HOST_RE.test(host)) throw new Error(`not a plain hostname: ${host}`);
  return [`*://${host}/*`, `*://*.${host}/*`, `*://${host}:*/*`, `*://*.${host}:*/*`];
}
