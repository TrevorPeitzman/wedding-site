# Wallet passes: what to set up with Apple and Google

Phase 4 needs two accounts before any pass can be signed. Both have waiting
time, so start them first; the code (generator, landing page, signing
function) can be built in parallel and switched on once they're approved.

At the end, you'll have a few **secrets**. None of them ever go in this repo:
they go into Supabase's secrets store (`supabase secrets set …`) when the
signing function is built.

| From | You end up with | Secret? |
| --- | --- | --- |
| Apple | Team ID, Pass Type ID (`pass.…`) | No |
| Apple | Pass Type ID certificate + its private key, exported as a `.p12` with a password | **Yes** |
| Apple | WWDR intermediate certificate (G4) | No (public) |
| Google | Issuer ID | No |
| Google | Service account email | No |
| Google | Service account JSON key | **Yes** |

---

## Apple Wallet

Checked against Apple's pages on Nov 4, 2026 (links below each step).

### 1. Enroll in the Apple Developer Program ($99/year)

https://developer.apple.com/programs/enroll/

- Enroll as an **individual**. You need an Apple Account with two-factor
  authentication on, and you must be the legal age of majority.
- Use your **legal name** in the Apple Account's first and last name. Apple
  says an alias or nickname "will cause a delay in the approval of your
  enrollment". They also verify email, phone and address (no P.O. boxes).
- A D-U-N-S number is only for organizations; you don't need one.
- Apple doesn't publish an approval time. After verification you accept the
  license agreement and pay.

### 2. Create a Pass Type ID

https://developer.apple.com/help/account/capabilities/create-wallet-identifiers-and-certificates/

1. In **Certificates, Identifiers & Profiles**, click **Identifiers** in the
   sidebar, then the add button (+) at the top left.
2. Select **Pass Type IDs**, then Continue.
3. Enter a description ("KT 1121 boarding pass") and an identifier. The usual
   convention is reverse-DNS starting with `pass.`, for example
   `pass.net.peitzman.wedding` (a convention, not a rule stated on that page).
4. Review, then **Register**.

You need to be the Account Holder or an Admin, which you are as an individual.

### 3. Create the Pass Type ID certificate

Same page, plus https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request

1. **Make a certificate signing request (CSR) on a Mac:** open Keychain Access
   (`/Applications/Utilities`), then **Keychain Access → Certificate Assistant →
   Request a Certificate from a Certificate Authority**. Enter your email and a
   common name ("KT 1121 passes"), leave CA Email Address empty, choose
   **Saved to disk**, Continue. This also creates the private key in your
   keychain.
2. In Certificates, Identifiers & Profiles: **Certificates** in the sidebar →
   (+) → under Services, **Pass Type ID Certificate** → Continue → pick the
   Pass Type ID from step 2 → upload the `.certSigningRequest` → Continue →
   **Download**. You get a `.cer` file.
3. Double-click the `.cer` so it joins its private key in Keychain Access.
   Then in Keychain Access, find the certificate (it starts "Pass Type ID:"),
   right-click → **Export**, save as `.p12`, and set a password. That `.p12`
   and its password are the signing secret. Keep them out of the repo, and
   ideally in a password manager.

No Mac? A CSR and key can be made with `openssl` instead; Apple's help only
documents Keychain Access, so ask and the steps can go here.

### 4. Note your Team ID and get the WWDR certificate

- **Team ID:** in your developer account, under **Membership details**. Passes
  carry it as `teamIdentifier`.
- **WWDR intermediate, G4:** Apple's table lists G4 for "Pass Type ID" certificates
  (https://developer.apple.com/help/account/certificates/wwdr-intermediate-certificates).
  Download it from https://www.apple.com/certificateauthority/. It's public;
  the signing function bundles it.

### Not yet checked against Apple

Apple's two Wallet format pages need JavaScript, so this session couldn't read
them:

- [Building a pass](https://developer.apple.com/documentation/walletpasses/building-a-pass)
- [Distributing and updating a pass](https://developer.apple.com/documentation/walletpasses/distributing-and-updating-a-pass)

The plan rests on what they're widely known to say, to confirm when we build
it: a pass is a zip (`pass.json`, images, `manifest.json`, a signature) with
the `boardingPass` style and `transitType` `PKTransitTypeAir`; it's served as
`application/vnd.apple.pkpass`; and no app is needed to add it from Safari.

---

## Google Wallet

**Unverified.** `developers.google.com` is blocked from the build session, so
these steps are from general knowledge of Google Wallet's setup, not read off
Google's current pages. Follow the official guide where it differs:
https://developers.google.com/wallet/tickets/boarding-passes

### 1. Create the issuer account (free)

- Go to the **Google Pay & Wallet Console**: https://pay.google.com/business/console
- Open the **Google Wallet API** section and create an issuer account
  (business name: what guests will see, e.g. "Katarina & Trevor").
- Note the **Issuer ID** it shows.

### 2. Set up a Google Cloud service account

- In Google Cloud Console (https://console.cloud.google.com), create a project
  ("wedding-wallet"), then enable the **Google Wallet API** for it.
- **IAM & Admin → Service accounts → Create**. Then on that account, **Keys →
  Add key → JSON**. The downloaded JSON is the signing secret.
- Back in the Pay & Wallet Console, under **Users**, invite the service
  account's email so it can manage passes for your issuer.

### 3. Test users, then publishing access

- New issuer accounts start in **demo mode**: only test accounts you list in
  the console can save passes. Add your and Katarina's Google accounts.
- **Request publishing access** in the console's Wallet API section as early
  as you can. Google reviews the issuer and a sample pass; no fixed timeline.
  Until it's granted, guests' Android phones can't save the pass, so the
  landing page must keep showing the on-screen pass as a fallback.

### 4. Questions to settle while reading Google's guide

- Does a boarding pass (`flightClass` / `flightObject`) accept a made-up
  carrier and flight ("KT 1121")? Google may validate the IATA carrier code.
  If it does, the fallback is a **Generic pass** designed to look like a
  boarding pass.
- The "Save to Google Wallet" link: a JWT signed with the service account
  key, opened at `https://pay.google.com/gp/v/save/<jwt>`; check its size
  limit against 105 passes (each guest gets their own link, so it's small).

---

## When the accounts are ready

Send over (outside the repo): the Team ID, Pass Type ID, Issuer ID and service
account email. The `.p12` with its password and the JSON key go straight into
Supabase secrets; the build only needs to know their names.
