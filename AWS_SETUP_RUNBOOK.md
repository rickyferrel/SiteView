# AWS Setup Runbook — for Claude for Chrome

**Goal:** Stand up the AWS infrastructure to host the Map Portal (Next.js 16 SSR + Postgres),
per the decisions already made:

- **Compute:** AWS Amplify Hosting (native Next.js SSR)
- **Database:** Amazon RDS for PostgreSQL (`db.t4g.micro`, cost-first)
- **Region:** `us-west-2` (Oregon)
- **Media:** external URLs only (no S3)

This document is written for a **browser agent** driving the AWS Management Console. Follow the
phases in order. Do not skip verification checks. Stop at every 🔶 **HUMAN** marker and wait for
the person. Record every 📋 **CAPTURE** value — later steps depend on them.

---

## ⚠️ Operating rules for the agent

1. **This creates billable AWS resources.** Before clicking any final **"Create"** button, state
   what will be created and its cost, and get explicit human confirmation.
2. **Never paste database passwords or secret values into the chat.** Use AWS Secrets Manager and
   reference secrets by name/ARN. When you must move a secret (e.g. into an Amplify env var), do it
   inside the console, not through the conversation.
3. **AWS console labels drift.** If an exact label isn't present, pick the closest match and say what
   you chose. If a screen looks materially different from this runbook, pause and describe it.
4. **Confirm the region reads `Oregon us-west-2` in the top-right of every screen** before creating
   anything. Resources in the wrong region are a common, costly mistake.

---

## Prerequisites (must be true before you start)

- [ ] 🔶 **HUMAN:** An AWS account with console access + MFA, already signed in.
- [x] Code pushed to GitHub `main` at **https://github.com/rickyferrel/SiteView**, including
      `amplify.yml` and an env-aware `src/lib/db.ts` that uses `pg` + `DATABASE_URL` in prod and
      PGlite locally. *(Done by Claude Code.)*
- [x] `migrate.sql` (the full schema) is in the repo root for the Phase 4 upload; `npm run migrate`
      is the CloudShell-free alternative. *(Done by Claude Code.)*
- [ ] 🔶 **HUMAN, when asked:** the WordPress site origin (for the iframe CSP) and the desired
      portal subdomain (e.g. `map.example.com`).

---

## Phase 0 — Sign in and set region

1. Go to `https://console.aws.amazon.com/`.
2. 🔶 **HUMAN:** complete sign-in + MFA if prompted.
3. Top-right region selector → choose **US West (Oregon) us-west-2**.
4. ✅ **Verify:** the region pill shows `Oregon` before proceeding.

---

## Phase 1 — Create the RDS PostgreSQL database

1. In the top search bar, type **RDS** → open **RDS**.
2. Left nav → **Databases** → **Create database**.
3. Choose **Standard create**.
4. **Engine options:** Engine type = **PostgreSQL**. Version = latest **PostgreSQL 16.x** offered.
5. **Templates:** select **Free tier** if the account is eligible (forces single-AZ, micro, cheapest).
   If Free tier is unavailable, select **Dev/Test**.
6. **Settings:**
   - DB instance identifier: `map-portal-db`
   - Master username: `postgres`
   - **Credentials management:** select **Manage master credentials in AWS Secrets Manager**.
     *(This makes RDS create and store the password automatically — no password to copy or paste.)*
7. **Instance configuration:** if not already forced by the template, choose **Burstable classes** →
   **db.t4g.micro**.
8. **Storage:** type **gp3**, allocated **20 GiB**. Turn **OFF** storage autoscaling (cost-first).
9. **Availability:** **Single-AZ** (no standby).
10. **Connectivity:**
    - Compute resource: **Don't connect to an EC2 compute resource**.
    - VPC: **Default VPC**.
    - **Public access: Yes.** *(Required — Amplify SSR compute lives outside your VPC and reaches RDS
      over the public endpoint, secured by TLS + credentials. See the security note in Phase 3.)*
    - VPC security group: **Create new** → name `map-portal-db-sg`.
11. **Additional configuration** (expand):
    - Initial database name: `mapportal`
    - Backup retention: **7 days**.
    - Leave encryption at default (enabled).
12. 🔶 **HUMAN confirm:** summarize — *"Creating db.t4g.micro Postgres 16, 20GB gp3, single-AZ,
    public, ~$0 on free tier then ~$13/mo. Proceed?"* — then click **Create database**.
13. 📋 **CAPTURE:** once status is **Available** (may take several minutes), open the DB →
    **Connectivity & security** tab and record the **Endpoint** (e.g.
    `map-portal-db.xxxx.us-west-2.rds.amazonaws.com`) and **Port** (`5432`).
14. 📋 **CAPTURE:** on the same page, note the **Secrets Manager secret** ARN/name RDS created for the
    master credentials (linked under "Manage master credentials").

---

## Phase 2 — Enforce TLS and lock the security group

### 2a. Require SSL (custom parameter group)

1. RDS left nav → **Parameter groups** → **Create parameter group**.
2. Type = **DB parameter group**, family = **postgres16**, name = `map-portal-pg16-ssl`. Create.
3. Open it → search parameter **`rds.force_ssl`** → **Edit** → set value to **1** → **Save changes**.
4. RDS → **Databases** → `map-portal-db` → **Modify** → **Additional configuration** → **DB parameter
   group** = `map-portal-pg16-ssl` → **Continue** → **Apply immediately** → **Modify DB instance**.
5. Reboot to apply: **Databases** → select `map-portal-db` → **Actions** → **Reboot**.
6. ✅ **Verify:** after reboot, the instance shows the custom parameter group and status **Available**.

### 2b. Security group inbound rule

1. On the DB's **Connectivity & security** tab, click the **VPC security group** (`map-portal-db-sg`).
2. **Inbound rules** → **Edit inbound rules** → ensure one rule: Type **PostgreSQL**, Port **5432**,
   Source **Anywhere-IPv4 `0.0.0.0/0`**.
   - ⚠️ Note in chat that the DB port is internet-reachable but auth-gated + TLS-only. This is the
     documented tradeoff of Amplify Hosting + RDS. Flag to the human that if a fully private DB is
     required, the plan should switch compute to **ECS Fargate**.
3. **Save rules.**

---

## Phase 3 — (Reference) Why public RDS

Amplify Hosting's SSR compute runs in an AWS-managed account and **cannot join your VPC**, so it
cannot reach a private-subnet RDS. The mitigation already applied: public endpoint + `rds.force_ssl=1`
+ Secrets-Manager-managed strong password. No action here — this phase is documentation for the human.

---

## Phase 4 — Run the schema migration (AWS CloudShell)

*Standard RDS Postgres has no in-console SQL editor, so use CloudShell (browser terminal) + psql.*

1. Top nav → click the **CloudShell** icon (`>_`), or search **CloudShell**. Wait for the shell.
2. Install the client:
   ```bash
   sudo dnf install -y postgresql16 || sudo yum install -y postgresql16
   ```
3. 🔶 **HUMAN / CAPTURE:** upload the migration file — CloudShell **Actions → Upload file** →
   select `migrate.sql` (the repo's `SCHEMA_SQL`). It lands in the home dir.
4. Retrieve the DB password from Secrets Manager into a shell variable (does not print it to chat):
   ```bash
   SECRET_ARN='<paste the RDS-managed secret ARN from Phase 1 step 14>'
   export PGPASSWORD=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" \
     --query SecretString --output text | python3 -c 'import sys,json;print(json.load(sys.stdin)["password"])')
   ```
5. Run the migration against the endpoint (TLS required):
   ```bash
   psql "host=<ENDPOINT from Phase 1> port=5432 dbname=mapportal user=postgres sslmode=require" \
     -f migrate.sql
   ```
6. ✅ **Verify tables exist:**
   ```bash
   psql "host=<ENDPOINT> port=5432 dbname=mapportal user=postgres sslmode=require" \
     -c "\dt"
   ```
   Expect: `developments`, `statuses`, `field_defs`, `filters`, `parcels`, `publications`.
7. Seeding: there is intentionally **no committed seed.sql** (it would embed the Mapbox token).
   After launch, create the Summit Creek development from the portal atlas UI (**/** → new) — the
   token prefills from `NEXT_PUBLIC_MAPBOX_TOKEN` — then import parcels.
8. `unset PGPASSWORD` and close CloudShell.

> **Alternative to CloudShell:** the repo has `npm run migrate`, which applies `migrate.sql` to
> whatever `DATABASE_URL` points at. It can be run from any machine that can reach the RDS endpoint
> (`DATABASE_URL='postgresql://…?sslmode=require' npm run migrate`), producing the same result as
> steps 3–6.

---

## Phase 5 — Create the Amplify Hosting app

1. Search **Amplify** → open **AWS Amplify** → **Deploy an app** (or **Create new app**).
2. Source: **GitHub** → **Continue**.
3. 🔶 **HUMAN:** complete the GitHub OAuth authorization popup (grant Amplify access to the repo).
4. Select the **repository** and branch **`main`** → **Next**.
5. **Build settings:** Amplify should auto-detect **Next.js (SSR / WEB_COMPUTE)**. Confirm the app
   platform is **Web Compute**, not "Static". If a build spec editor appears, ensure it matches the
   repo's `amplify.yml`. If Node version must be pinned, ensure preBuild contains:
   ```yaml
   preBuild:
     commands:
       - nvm install 24 && nvm use 24
       - npm ci
   build:
     commands:
       - npm run build
   ```
6. **Environment variables** (Advanced settings → add). The app reads exactly these:
   - `DATABASE_URL` =
     `postgresql://postgres:<PASSWORD>@<ENDPOINT>:5432/mapportal?sslmode=require`
     - 🔶 **HUMAN / secure:** fetch `<PASSWORD>` from Secrets Manager and paste it directly into the
       Amplify env-var field in the console — **do not** route it through chat. `<ENDPOINT>` is the
       Phase 1 value. `src/lib/db.ts` uses this single connection string (not discrete PG* vars).
     - **Paste the password verbatim, even if it has special characters** (`@ : / ? # %` …). The app
       parses the password literally, so **no URL-encoding is needed**. (Amplify passes env vars
       directly, unlike a local `.env` file — so special chars are safe here.)
   - `NEXT_PUBLIC_MAPBOX_TOKEN` = the public `pk.` Mapbox token. **Required** — without it the map
     does not render and new-development prefill is blank. (This is a publishable token; it ships to
     the browser by design.)
   - `EMBED_FRAME_ANCESTORS` = `https://<wordpress-origin>` — locks the `/embed/*` iframe to the
     WordPress site (space-separate multiple origins). Optional; if omitted the embed is frameable
     anywhere. 🔶 **HUMAN** provides the WordPress origin.
7. 🔶 **HUMAN confirm:** *"This creates an Amplify app that auto-builds on every push to main. Proceed?"*
   → **Save and deploy**.
8. Watch the pipeline: **Provision → Build → Deploy → Verify** all green.
9. 📋 **CAPTURE:** the default Amplify URL (e.g. `https://main.dxxxx.amplifyapp.com`).

---

## Phase 6 — Smoke-test the deployment

Using the captured Amplify URL:

1. Open `https://<amplify-url>/` → the **atlas** page should load.
2. Open `https://<amplify-url>/embed/summit-creek` → the map should render (allow ~10s for tiles).
   *(Only if Summit Creek was seeded in Phase 4 step 7.)*
3. Open `https://<amplify-url>/api/dev/summit-creek/config` → should return JSON, not a 500.
   - ❌ A 500 here usually means the DB connection failed → recheck `DATABASE_URL`, the SG rule, and
     that `rds.force_ssl` didn't reject a non-SSL connection.
4. ✅ Report pass/fail for each to the human.

---

## Phase 7 — Custom domain + HTTPS

1. 🔶 **HUMAN:** provide the desired subdomain (e.g. `map.example.com`) and confirm where DNS is
   hosted (Route 53 or external).
2. Amplify app → **Hosting → Custom domains** → **Add domain**.
3. Enter the root domain; map the subdomain to the `main` branch.
4. **DNS records:**
   - If the domain is in **Route 53**, Amplify can add records automatically — approve.
   - If DNS is **external**, 📋 **CAPTURE** the CNAME/validation records Amplify shows and 🔶 **HUMAN**
     adds them at the registrar. Wait for status **Available** (ACM cert issues automatically).
5. ✅ **Verify:** `https://map.example.com/embed/summit-creek` loads over HTTPS with a valid cert.

---

## Phase 8 — Handoff notes for the WordPress iframe

- The `frame-ancestors` CSP is **already implemented** in `next.config.ts`, driven by the
  `EMBED_FRAME_ANCESTORS` env var set in Phase 5. Confirm it's set to the WordPress origin; then the
  `/embed/*` responses carry `Content-Security-Policy: frame-ancestors https://<wordpress-origin>`.
- 🔶 **HUMAN (WordPress side):** update the `<iframe src>` to
  `https://map.example.com/embed/summit-creek`.

---

## Final report template

When done, report to the human:

- RDS endpoint + status, parameter group, SG rule ✅/❌
- Migration: tables present ✅/❌ (list them), seeded? yes/no
- Amplify app URL + last build status
- Custom domain + cert status
- Smoke tests: `/`, `/embed/summit-creek`, `/api/.../config` results
- Outstanding 🔶 **HUMAN** items (domain DNS, CSP header, WordPress iframe swap)
