# GrowSigning: what the software does for each control area, and what is left to whoever runs it

**A self-assessment by the authors. Not audited, not certified.**

Written on 21 November 2026, from the code as it was that day.

## What this is not

- It is not a certificate, an audit report or a statement that any standard is met. Nobody outside the project has
  checked it.
- It is not a claim about your installation. Most of what the two lists below ask for is the work of the people who
  run a server (the operator), not of software. Each row says which part is which.
- It is not complete at the level of single controls. It goes area by area. ISO/IEC 27001:2022 Annex A has 93
  controls; they are grouped here under its four themes, and a row covers the controls of that theme the software
  has anything to do with. NIST SP 800-53 is not covered at all.
- It does not replace a penetration test. None has been done.

How to read a row: "What the software does" is true of the code, and names the file it rests on, so you can check it.
"What the operator must do" is not done by anything in this repository. Where the software does nothing, the row
says "Nothing".

## ISO/IEC 27001:2022 Annex A, by theme

### 5 Organizational controls

| Area | What the software does | What the operator must do |
| --- | --- | --- |
| Policies, roles, responsibilities (5.1 to 5.4) | Nothing. | Write the policies, name who is responsible, and keep them up to date. |
| Contact with authorities and interest groups, threat intelligence (5.5 to 5.7) | Nothing. | All of it. |
| Inventory of information and assets (5.9 to 5.13) | One list of what is stored and where: the database and the folder of stored files, both under `DATA_DIR` (`src/server/db.ts`, `src/server/filestore.ts`). `/security` and the data processing summary print what is kept and what is not encrypted (`src/lib/dataplace.ts`). A software bill of materials is made at every build (`scripts/sbom.mjs`). | Keep your own inventory of servers, disks, backups and keys. Classify the documents your people upload: the software does not. |
| Access control and identity (5.15 to 5.18) | Logins with a password stored as an scrypt hash (`src/server/auth.ts`), optional two-step login with an authenticator app (`src/server/twostep.ts`), optional sign-in with Google or Microsoft (`src/server/oidc.ts`). Three roles in an account (owner, admin, member), checked on every route (`src/server/router.ts`). API keys that carry less than their maker's role. Who can use or change each template (`src/server/tplroles.ts`). | Decide who gets a login and which role, take logins away when people leave, and require two-step login for your account if you want it (Settings has the switch). There is no single sign-on with SAML and no directory sync. |
| Supplier relationships and cloud services (5.19 to 5.23) | One list of every outside service the server can connect to, on or off, from the settings it runs on (`src/lib/outside.ts`), printed on `/security`. `OUTSIDE_CALLS=none` switches off everything but the mail relay (`src/server/outside.ts`). | Choose the suppliers, sign the agreements with them, and check them. The software has no agreement with anyone. |
| Incident management (5.24 to 5.28) | A record per account of sign-ins, failed sign-ins and changes to logins, the team and keys, which cannot be edited through the application and is chained by hashes (`src/server/seclog.ts`). An audit trail per envelope, chained the same way (`src/server/envelopes.ts`). Alerts to the operator queue when a stored file fails its check (`src/server/filestore.ts`). A contact for reports from outside (`src/lib/selfhost.ts`). | Staff the contact. Decide who is told and when; the software sets no deadline and cannot meet one for you. Runbooks to start from are in `docs/runbooks.md`. Collect the server log somewhere it cannot be changed: the software writes to standard output only. |
| Business continuity (5.29, 5.30) | A backup made while the server runs and a restore that checks every file and every chain (`scripts/backup.mjs`, `scripts/restore.mjs`). A health check for monitoring (`src/server/selfhost.ts`). | Run the backup on a schedule, keep copies somewhere else, and practise a restore. One server, one database file: there is no second site and no failover in the software. |
| Legal requirements, records, privacy (5.31 to 5.36) | A retention rule per account, a legal hold, deletion of an account and of single envelopes, and an export of an account's data (`src/server/records.ts`, `src/server/deleting.ts`). | Find out which laws apply to you and whether an electronic signature of this kind is enough for your documents. The software makes no such promise. A data processing agreement is yours to write. |

### 6 People controls

| Area | What the software does | What the operator must do |
| --- | --- | --- |
| Screening, terms of employment, awareness, discipline, leaving (6.1 to 6.6) | Nothing. | All of it. |
| Remote working (6.7) | Sessions end 90 days after sign-in at the latest, and a person can see and end their other sessions (`src/server/auth.ts`). | Rules for the devices your people use. |
| Reporting security events (6.8) | `/security/disclosure` and `/.well-known/security.txt`, made from `SECURITY_CONTACT` (`src/lib/selfhost.ts`). The page promises an answer within `SECURITY_REPLY_DAYS` only when you set it. | Read the mailbox, and answer in the time you published. |

### 7 Physical controls

| Area | What the software does | What the operator must do |
| --- | --- | --- |
| Buildings, rooms, equipment, cabling, disposal (7.1 to 7.14) | Nothing. Software cannot. | All of it, or a hosting agreement that covers it. Stored files can be encrypted by the application (`src/server/filecrypt.ts`), which helps when a disk is thrown away or stolen, but the database is not encrypted by it: encrypt the disk. |

### 8 Technological controls

| Area | What the software does | What the operator must do |
| --- | --- | --- |
| Privileged access and access to source (8.2 to 8.4) | No hidden administrator and no remote access for the authors. Operators are named by `OPERATOR_EMAILS` and see only what `/security` lists. | Guard the server, its settings and its disk: whoever has them reads everything. |
| Authentication (8.5) | Rate limits on sign-in and on codes (`src/server/util.ts`), two-step login (`src/server/twostep.ts`), one-time codes kept only as keyed hashes. A new password is looked up in a list of leaked passwords, sending only the first 5 characters of its SHA-1 (`src/server/pwned.ts`); `PWNED_CHECK=0` switches that off. | Decide whether two-step login is required. |
| Capacity and availability (8.6, 8.14) | The health check fails when less than 1 GB is free or the timer stops (`src/server/selfhost.ts`). | Watch it and act. One process and one disk: no redundancy. |
| Malware and vulnerabilities (8.7, 8.8) | Uploaded files are read as PDF or picture and never run; office files are converted in a separate process (`src/server/convert.ts`), which has no network only where `unshare -rn` works on the host. In the container as shipped (all capabilities dropped, no new privileges) it does not work, so LibreOffice there has whatever network the container has, and the server log says so. Uploads are not scanned for malware. The bill of materials lists every package and version (`scripts/sbom.mjs`). | Scan uploads if you need that. If you switch LibreOffice on, deny egress in the network around the server, or use the `gotenberg` service of `docker-compose.example.yml` (its `office` profile), which sits alone on a network with no route out. Watch the packages in the bill of materials for published weaknesses and rebuild: nothing in the software does this for you, and the authors promise no patch time. |
| Configuration and hardening (8.9) | The container runs as a user without privileges, with a read-only root file system and one writable volume (`deploy/helm/growsigning/templates/deployment.yaml`). A wrong setting is logged at start and its feature stays off (`src/instrumentation.ts`). | Keep the settings and the two keys in a secret store. Review them. |
| Deletion, masking, leakage (8.10 to 8.12) | Retention and deletion as above (`src/server/records.ts`). The health check and error messages name no account. | Deletion does not reach your backups. Decide how long those are kept. |
| Backup (8.13) | `scripts/backup.mjs` and `scripts/restore.mjs`, tested as a round trip in `tests/selfhost.test.ts`. The keys are never in a backup. | Schedule it, store the copies apart, encrypt them (the database inside is readable), keep the keys somewhere else, test a restore. |
| Logging and monitoring (8.15, 8.16) | The security record and the audit trails, both chained, with an API to pull the security record (`src/server/routes-seclog.ts`). Refused outside connections are logged once an hour per host (`src/server/outside.ts`). | Ship the server log to your own system and look at it. The chains show a change made through the database, to someone who checks them; they do not stop one. |
| Clock (8.17) | Times are the server's clock. A trusted time from a time-stamp service is added to the seal of a signed PDF only when `TSA_URL` is set (`src/server/tsa.ts`). | Keep the server's clock right. |
| Networks and web filtering (8.20 to 8.23) | `OUTSIDE_CALLS` holds connections the server opens itself to a list (`src/server/outside.ts`); webhooks are refused to private addresses, or held to `WEBHOOK_ALLOW_HOSTS` (`src/server/webhooks.ts`). This is a second line of defence, not a firewall. | Enforce egress in the network: the chart has a policy that denies it by default (`deploy/helm/growsigning/templates/networkpolicy.yaml`). Put TLS in front: the application speaks plain http and does none itself. |
| Cryptography (8.24) | scrypt for passwords (`src/server/auth.ts`); AES-256-GCM with a key per file from HKDF-SHA256 for stored files (`src/server/filecrypt.ts`); HMAC-SHA256 with `APP_SECRET` for links, codes and seals (`src/server/util.ts`); SHA-256 chains for audit trails; an optional digital seal on signed PDFs (`src/server/seal.ts`). No hardware security module. | Make, store and rotate the keys (`docs/runbooks.md`). Lose `FILE_ENCRYPTION_KEY` and the encrypted files are gone. |
| Development (8.25 to 8.34) | The tests in `tests/` run without a network. Type checking is part of the build. The lockfile pins every package. | Review changes before you deploy them. No independent code review or penetration test has been done. |

## UK NCSC Cloud Security Principles

These fourteen principles are written for a cloud service. They apply to you as the one who runs this software for
others; the software is one part of that service.

| Principle | What the software does | What the operator must do |
| --- | --- | --- |
| 1. Data in transit protection | Nothing itself: it speaks plain http behind your proxy. Cookies are marked Secure when the request came over https. Mail goes to your relay with the TLS settings of `SMTP_URL` (`src/server/mail.ts`). | TLS at the reverse proxy, and between the proxy and the server if they are on different machines. |
| 2. Asset protection and resilience | Stored files encrypted by the application when `FILE_ENCRYPTION_KEY` is set (`src/server/filecrypt.ts`). `/security` states where the data is from `DATA_REGION` and the other settings, and says so when they are not set (`src/lib/dataplace.ts`). | Choose where the server is. Encrypt the disk (the database is not encrypted by the application). Backups, a second copy, disposal of disks. |
| 3. Separation between customers | Every row belongs to an account and every route reads through the caller's account (`src/server/router.ts`); the tests include reading across accounts. All accounts share one database and one process. | If two bodies must not share a database, run two installations. |
| 4. Governance framework | Nothing. | All of it. |
| 5. Operational security | The health check, the bill of materials, the log lines at start for every setting that is wrong. | Change management, vulnerability management, monitoring, incident management. |
| 6. Personnel security | Nothing. | All of it. |
| 7. Secure development | Tests, type checking, a pinned lockfile, a build that can be repeated (`docs/runbooks.md`). No outside review. | Review what you deploy. |
| 8. Supply chain security | The bill of materials with every licence read (`scripts/sbom.mjs`), and the list of outside services (`src/lib/outside.ts`). | Assess your hosting company, mail relay and any service you switch on. |
| 9. Secure user management | Roles, invitations, removal of members, API keys with their own limits (`src/server/router.ts`). | Decide who is an admin. |
| 10. Identity and authentication | Passwords, two-step login, optional Google or Microsoft sign-in (`src/server/twostep.ts`, `src/server/oidc.ts`). A signer is identified by reaching the link sent to their address, plus an access code or a one-time code when the sender asks for one. No identity documents are checked. | Require two-step login if you need it. Decide whether that level of signer identification is enough for your documents. |
| 11. External interface protection | One public interface: the web application and its API on one port. Rate limits per caller address (`src/server/util.ts`). | A firewall, the reverse proxy, protection against floods. Set `TRUSTED_PROXY_HOPS` correctly or the limits count the wrong address. |
| 12. Secure service administration | No administration interface apart from the application itself; operators act through settings on the server. | Protect access to the server and to its settings. |
| 13. Audit information for users | The security record per account, in Settings and through the API, and the audit trail of each envelope (`src/server/seclog.ts`, `src/server/envelopes.ts`). | Tell your users it exists. |
| 14. Secure use of the service | `/security` says what is and is not protected, in plain words. | Guidance for your own users. |

## What is not done, in one place

- No audit, no certification, no penetration test, no outside code review.
- No encryption of the database by the application, no hardware security module, no customer-held keys.
- No malware scan of uploads.
- No single sign-on with SAML, no directory sync.
- No high availability: one process, one SQLite file, one writer.
- No promise from the authors about how fast a weakness is fixed. This matters if you distribute the software or an
  image of it commercially in the European Union: the Cyber Resilience Act then puts duties for handling
  vulnerabilities on whoever places it on the market. Find out whether that is you. The bill of materials and
  `/security/disclosure` are tools for that work, not the work.
