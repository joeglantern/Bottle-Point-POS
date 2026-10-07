# Selling without internet

The till keeps selling when the internet drops, in Chrome, with nothing to install. Sales made offline are kept on the till and sent to the server when the connection is back. Nothing is recorded twice, and no sale is lost or refused because of what happened while the till was offline.

## For the shop

**When the internet drops** a red strip appears: *Offline. Keep selling.*

| Works offline | Waits for the internet |
|---|---|
| Selling, scanning and searching products | M-Pesa prompts (they need Safaricom) |
| Cash, typed M-Pesa codes and split payments | Discounts, cancelling and refunds (they need a manager's approval) |
| Saving tabs, and paying tabs from before the outage | Closing a shift (the count must include every sale) |
| Opening a shift | Changing a tab from before the outage (start a new sale for extra items) |
| Printing receipts | Products, stock, staff, reports and settings |
| Signing in and out | |

- **Receipts printed offline** carry the till's own number, for example `T2-0041` (till T2, its 41st offline sale), with a barcode. When the sale reaches the server it also gets a normal number. Scanning the offline receipt later still finds the sale.
- **Signing in offline:** anyone who signed in on this till with internet in the last 14 days can sign in offline with their PIN. Others are told they need internet. Five wrong PINs lock offline sign in on that till for 5 minutes.
- **When the internet is back** a strip says *Sending N offline sales*, then it disappears. If someone signed in offline, they enter their PIN once more to carry on.
- **Reloading or restarting** the till while offline is fine: Bottle Point opens from the till itself. Do not clear Chrome's history or site data on a till that shows offline sales waiting.
- **If something cannot be sent** (rare: the till was removed in Settings, for example) a red strip offers **Download**. Nothing is deleted: give the file to the owner.

**Managers:** the Today page shows **Offline sales to check** when an offline sale needs a look. The sale is always recorded; this is the follow up. Mark each one **Dealt with** with a short note. You will see:

| Note | What happened | What to do |
|---|---|---|
| Cash arrived after the shift was counted | Cash was taken offline into a shift that was closed meanwhile | The drawer was over by that amount; adjust or note it |
| M-Pesa code already linked to another sale | The same code was typed twice | Check the statement. The sale stays unpaid until then |
| Customer may have paid twice | A tab was paid offline on one till and online on another | Check with the customer and refund if so |
| Tab changed on another till | The offline till charged for an older version of the tab | Check what the customer paid |
| Price lower than the catalog | Usually the price changed while the till was offline | Nothing, if that is the reason |
| Shift merged | Someone opened a shift offline while their shift was open elsewhere | Check the float |
| Not signed in on this till before / not their shift | A sale names someone unexpected | Check it was really them |
| Till clock ahead or sale very old | The till's date and time are wrong | Fix the till's clock |

**Owners:** Settings, Devices, **Tills** lists every till (T1, T2...) and when it last synced. **Remove** a lost or retired till: its key stops working at once.

## How it works

1. **The app on the device.** A service worker (`vite-plugin-pwa`, `web/vite.config.js`) keeps the app's files, so it opens with no internet. A new version waits until someone taps **Reload now**, never in the middle of a sale.
2. **The data on the device.** IndexedDB (`web/src/offline/db.js`) keeps the products and prices, unpaid tabs, the cashier's shift and the shop's receipt details, refreshed whenever the till is online.
3. **The same screens.** Every request goes through `web/src/api.js`. When the server cannot be reached (no network, a timeout, or the proxy answering 502 to 504), the request is answered by `web/src/offline/local.js` instead, so the till screens do not change. Sales made offline get an id made on the till and a receipt number from the till's own counter.
4. **The queue.** Everything recorded offline goes into an outbox, in order (`web/src/offline/outbox.js`). A tab changed several times is sent once, in its final state.
5. **Sending.** `web/src/offline/sync.js` sends the outbox whenever the server is reachable: on reconnecting, every 20 seconds, and after each offline sale. It uses the till's own key (`x-device-token`), so it works even after the cashier's session has ended. One tab sends at a time.

### Never twice

- Every sale, payment and offline shift has an id made on the till (`clientId`, unique in the database). The online endpoints accept it too: creating a sale or paying with an id the server already has returns the first result. So a request that timed out and was then finished offline cannot create a second sale or payment.
- Every synced item has its own `opId`. The server stores the answer it gave (`OfflineOp`), and an item sent again gets the same answer without doing anything.
- Each item is one database transaction: it lands completely or not at all.

### Never refused, always flagged

`server/src/rules/offline.ts` records every offline sale whose money changed hands. Anything unusual becomes an `OfflineIssue` for a manager (the table above), instead of an error. Only items that cannot be true are refused: a product, person or branch of another business, a receipt number of another till, or a malformed item. The till keeps refused items and offers them for download.

Offline sales use the time on the till's clock (when they actually happened), unless the clock is clearly wrong. Stock goes down when the sale is synced and may go below zero; a count fixes it.

### Signing in offline

When someone signs in with internet, the till keeps a PBKDF2 SHA-256 fingerprint of their PIN (200,000 rounds, random salt), never the PIN. Offline, the PIN typed is checked against it. The fingerprint expires 14 days after the last online sign in, and anyone the owner switched off is forgotten the next time the till is online. An offline sign in has no server session, so when the internet is back the person enters their PIN once more.

### Tills

The first sign in on a browser registers it as a till (`POST /api/offline/devices`): it gets a code (T1, T2...) and a random key. The server stores only the key's SHA-256 hash. The key can do exactly one thing, send offline items for its own shop (`POST /api/offline/sync`), and works only on that shop's address. Each online sign in on the till is recorded (`DeviceUser`), so an offline sale naming someone who never used that till is flagged, and cash is only counted in the shift of the person who took it.

## API

| Method and path | Who | What |
|---|---|---|
| `POST /api/offline/devices` | signed in | Register this browser as a till. Returns `{ device: { id, code, name }, token }`; the token is shown once |
| `POST /api/offline/devices/seen` | signed in, with `x-device-token` | Record that this person signed in on this till |
| `GET /api/offline/devices` | manager | The shop's tills |
| `POST /api/offline/devices/:id/revoke` | manager | Remove a till |
| `GET /api/offline/bootstrap?users=id,id` | signed in | Receipt details to keep, and which of those people are still active |
| `POST /api/offline/sync` | `x-device-token` | `{ ops: [...] }`, up to 25. Each op is `shift_open`, `sale` or `pay` (schemas at the top of `server/src/rules/offline.ts`). Returns `{ results: [{ opId, status: ok \| rejected \| retry, sale?, shift?, message? }] }` |
| `GET /api/offline/issues?status=open\|all&branchId=` | manager | Offline sales to check |
| `POST /api/offline/issues/:id/resolve` | manager | `{ note }` |

`POST /api/sales` accepts an optional `clientId` (UUID), and each item of `POST /api/sales/:id/pay` an optional `clientId`, for safe retries.

## Testing

- `server/test/offline.test.ts`: never twice, cash after a shift was closed, a code used twice, a tab paid on two tills, merged shifts, wrong clocks, refusals, till users, managers' list.
- `web/e2e/offline.mjs`: the production build in Chrome with the till's web server switched off. The page reloads offline, sells for cash, saves a tab, signs out and in offline, pays a tab from before the outage, opens a shift offline, then the server comes back and everything is checked on it.
