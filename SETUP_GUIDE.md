# Kovai Lakshmi Grinders — Billing System
## Setup Guide (written for a complete beginner — follow every step in order)

You now have 4 files:
- `index.html`, `style.css`, `app.js` → the website (goes to GitHub)
- `Code.gs` → the backend (goes to Google Apps Script, bound to a Google Sheet)

This is **Phase 1**: login, bill creation with live preview, UPI QR via Razorpay,
webhook auto-confirmation, dashboard, admin settings, bill lookup/edit. Everything
is wired end-to-end and ready to deploy.

---

## STEP 1 — Create the Google Sheet (your database)

1. Go to [sheets.google.com](https://sheets.google.com) → **Blank spreadsheet**.
2. Rename it: **Kovai Lakshmi Billing DB**.
3. Click **Extensions → Apps Script**. A new tab opens (the code editor).
4. Delete anything inside the default `Code.gs` file that opens, and paste in
   the **entire contents** of the `Code.gs` file I gave you.
5. Click the **Save** icon (or Ctrl+S).
6. In the function dropdown at the top (next to the "Debug" button), select
   **setupDatabase**, then click **Run** (▶).
   - The first time, Google will ask you to authorize the script — click
     **Review permissions → (your account) → Advanced → Go to project (unsafe)
     → Allow**. This is normal; it's your own script running on your own sheet.
   - A popup will show your **Webhook Token** — copy it somewhere safe, you'll
     need it in Step 5.
7. Go back to the spreadsheet tab. You'll now see sheets: `Settings`,
   `Billers`, `Customers`, `Products`, `Bills`, `BillItems`, `PaymentLogs`,
   `Dashboard`. A default biller **B001 / Kovai Lakshmi / DS0512** and 5 sample
   products were created — edit or delete these later from the Admin Settings
   screen once the site is live.

---

## STEP 2 — Deploy the Apps Script as a Web App (this becomes your "API")

1. Back in the Apps Script editor, click **Deploy → New deployment**.
2. Click the gear icon ⚙️ next to "Select type" → choose **Web app**.
3. Fill in:
   - Description: `Billing API v1`
   - Execute as: **Me (your account)**
   - Who has access: **Anyone**
4. Click **Deploy**. Authorize again if asked.
5. Copy the **Web app URL** shown (looks like
   `https://script.google.com/macros/s/AKfycb.../exec`). This is your `API_URL`.

> **Important — every time you edit `Code.gs` later:** you must go to
> **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**
> for the changes to go live. Just saving the file is not enough.

---

## STEP 3 — Get your Razorpay keys

1. Sign up / log in at [razorpay.com](https://razorpay.com) and complete KYC
   (needed to accept real payments; Test Mode works without KYC for trying
   things out).
2. Go to **Settings → API Keys → Generate Key** → copy the **Key ID** and
   **Key Secret**.
3. You will paste these into the app itself later (Admin Settings → Shop
   Details), **not** into any code file — they're stored securely in your
   Google Sheet's Settings tab, which only you can open.

---

## STEP 4 — Connect the frontend to your backend

1. Open `app.js` in any text editor (Notepad, VS Code, etc.).
2. Find this near the top:
   ```js
   const CONFIG = {
     API_URL: 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE'
   };
   ```
3. Replace the text with the Web App URL you copied in Step 2, e.g.:
   ```js
   API_URL: 'https://script.google.com/macros/s/AKfycb.../exec'
   ```
4. Save the file.

---

## STEP 5 — Set up the Razorpay Webhook (auto payment confirmation)

This is what makes the bill automatically flip from "Pending" to "Paid" the
moment a customer scans the QR and pays — no manual checking needed.

1. In Razorpay Dashboard → **Settings → Webhooks → Add New Webhook**.
2. **Webhook URL**: your Apps Script Web App URL **plus** `?token=` and your
   Webhook Token from Step 1, e.g.:
   ```
   https://script.google.com/macros/s/AKfycb.../exec?token=YOUR-WEBHOOK-TOKEN
   ```
3. **Active events**: tick `qr_code.credited`.
4. Save. (Razorpay also asks for a "Secret" field for header-signature
   verification — Apps Script can't read custom headers, so we don't rely on
   that; instead the app re-confirms every payment directly with Razorpay's
   API using your Key Secret before marking a bill Paid. You can still fill
   the Secret field in Razorpay for their own records, it just won't be
   checked on our side.)

> If you skip this step, payments still work — the biller can just tap
> **"Check Payment Status Now"** on the QR screen to confirm manually.

---

## STEP 6 — Host the website on GitHub Pages

1. Create a free GitHub account if you don't have one.
2. Create a new repository, e.g. `kovai-lakshmi-billing` (Public).
3. Upload `index.html`, `style.css`, `app.js` to the root of the repository
   (GitHub → **Add file → Upload files**).
4. Go to repository **Settings → Pages**.
5. Under "Build and deployment" → Source: **Deploy from a branch** → Branch:
   **main** / folder **/(root)** → **Save**.
6. Wait ~1 minute, then your site is live at:
   ```
   https://yourusername.github.io/kovai-lakshmi-billing/
   ```
7. Go to Admin Settings → Shop Details in your live site and set **Website**
   to this exact URL (this is just printed on the bill, cosmetic only).

---

## STEP 7 — First login & final setup

1. Open your GitHub Pages URL.
2. Log in with:
   - Username: `Kovai Lakshmi`
   - Password: `DS0512`
3. Go to **Admin Settings**:
   - Enter the Super Admin username/password at the top (same as login) —
     this is required before saving any admin change.
   - **Shop Details tab**: set your real logo image URL (upload a logo image
     anywhere public, e.g. [postimages.org](https://postimages.org) or your
     GitHub repo, and paste the direct image link), company name, address,
     phone, website, GST number, and your Razorpay Key ID / Key Secret.
   - **Billers tab**: add real biller names & passwords for your staff, and
     deactivate/delete the sample `B001` if you don't want to keep it.
   - **Products tab**: add your real product catalog.
4. Go to **Create Bill** and generate a test bill to confirm everything works
   end-to-end (try both Cash and UPI).

---

## How the pieces fit together (quick mental model)

```
 Browser (GitHub Pages)  ── fetch() ──▶  Apps Script Web App (Code.gs)
      index.html/app.js                      │
                                              ├─▶ Google Sheet (your DB)
                                              └─▶ Razorpay API (create QR,
                                                   confirm payments)
                          ◀── webhook ────  Razorpay (when customer pays)
```

- The **website never talks to Razorpay or the Sheet directly** — it only
  ever talks to your Apps Script URL. That's what keeps your Razorpay Key
  Secret and Sheet safe.
- **"Download PDF"** uses the browser's built-in print dialog (Print →
  Save as PDF) styled to look like a clean invoice — no external PDF library
  needed, works offline, and keeps to your "no third-party script" rule.
- The **QR code image** is generated directly by Razorpay's servers
  (`image_url` from their QR Codes API) — the browser just displays that
  image, no QR-drawing library involved.

---

## What's intentionally simple in this v1 (tell me if you want these next)

- Dashboard charts are hand-drawn with plain SVG (no chart library) — clean
  and fast, but simpler than something like Chart.js. Happy to upgrade the
  visuals if you want more chart types.
- The `Dashboard` sheet tab is a placeholder; run `buildDashboardSheet()`
  once from the Apps Script editor any time to populate it with live
  formulas + a product breakdown you can view directly in Sheets.
- Mobile: the sidebar collapses into a hamburger menu and the live bill
  preview stacks below the form automatically under ~1080px width.
- Session login is per-browser-tab (clears on browser close) — tell me if you
  want a "remember me" option instead.

Ping me once this is deployed and I'll help you test the Razorpay webhook
flow, add more dashboard charts, or refine anything in the bill layout.
