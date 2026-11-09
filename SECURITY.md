# Security

Cradlelog holds sensitive information about a child, so it is built to be exposed to the internet by one
family, with one shared passcode.

## What it does

- **Passcode.** At least 8 characters, hashed with scrypt; nothing is stored in plain text. A new install
  has no passcode: the first person to open it is asked to choose one, and that screen disappears for good
  once it's done. Until then the app holds no data and shows nothing, but whoever gets there first owns it, so
  claim it straight after deploying (or set `CRADLELOG_PASSCODE` in the environment to skip this). If someone
  else gets there first, delete the data volume and start again.
- **Sign-in limits.** Five wrong passcodes from one address lock that address out for 15 minutes.
  Every request is also limited per address.
- **Sessions.** A random token in an `HttpOnly`, `SameSite=Strict`, `Secure` cookie (`__Host-` prefixed over HTTPS).
  Only a hash of the token is stored, sessions expire after 180 days, and Settings has Sign out.
- **Signed-out visitors** can see the sign-in page and the app version. Nothing else, including settings and dates.
- **Cross-site requests** that change data are refused (`Sec-Fetch-Site` and `Origin` checks).
- **Headers.** A strict Content-Security-Policy (no inline scripts, no third-party hosts), HSTS over HTTPS,
  `nosniff`, no framing, no referrer, and `no-store` on every API response.
- **Alerts.** Push subscriptions are only accepted for the browsers' own push services (Google, Apple,
  Mozilla, Microsoft), at most 50.
- **Container.** Runs as a non-root user with a read-only filesystem and all capabilities dropped.

## What it does not do

- One shared passcode, no per-person accounts or audit trail. Anyone with the passcode can read and change everything.
- It does not terminate HTTPS. Use a reverse proxy (see the README) and never expose port 8080 directly.
- The database is not encrypted at rest. Use disk encryption on the host if that matters to you.
- Pick a long passphrase. The limits above slow guessing; they do not stop a short passcode from being guessed eventually.

## Reporting a problem

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button on the
Security tab, not in a public issue.
