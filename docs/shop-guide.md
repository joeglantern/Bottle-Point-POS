# Shop guide

For shop owners, managers and cashiers using Bottle Point at their shop's own address, for example `https://nyrolix.pos.flarehub.co.ke`. It works on a tablet, a phone, a touchscreen till or a laptop. Add it to the home screen for a full screen app (Chrome: menu, Add to home screen. Safari: Share, Add to Home Screen).

## Signing in

1. Type your **username** and your **PIN** (4 to 6 digits), then press **Sign in**. A keyboard works too: type the digits and press Enter.
2. The till remembers the last username. If someone else is signing in, press **Not you?**.
3. Five wrong PINs lock the account for 5 minutes. The owner can set a new PIN under Staff.

Sign out from the menu (the arrow at the bottom of the side bar, or **More** on a phone). On a shared till, always sign out when you finish.

## Shifts and the cash drawer

- Cashiers open a shift when they sign in: count the cash in the drawer and enter it as the **opening float**.
- The **Till** button at the top shows how much cash the drawer should hold now: float plus cash taken minus cash refunds.
- At the end, press it, count the drawer, enter the counted amount and **Close shift**. Any shortage or excess is recorded and shows on the manager's Today screen.
- Managers and owners can skip opening a shift if they will not take cash.

## Selling

1. Tap a product, search for it, or **scan its barcode** (see [Scanners and printers](hardware.md)). Tapping again adds one more.
2. Change quantities with **minus** and **plus**. Add a label (a table number or a name) or a customer if you like.
3. Then either:
   - **Pay now** to take payment straight away, or
   - **Save for later** to keep a tab open. Saved sales appear under **Unpaid sales** on every till in the branch, and you can add to them until they are paid.

On a phone or a tablet held upright, the order is in the bar at the bottom: tap **View order**.

## Taking payment

| Method | How |
|---|---|
| **Cash** | Enter what the customer handed over (or tap Exact or a note). The change shows. Press **Confirm receipt of payment**. |
| **M-Pesa prompt** | Appears once the owner has entered the shop's own Paybill or Till keys in Settings, M-Pesa. Enter the customer's phone number and **Send prompt**. The customer enters their M-Pesa PIN on their phone and the sale turns paid by itself. If nothing happens, **Check status**. If they cancel or it fails, **Send again** or use a typed code. |
| **M-Pesa code** | The fallback. Type the 10 character code from the customer's M-Pesa message. A manager checks typed codes later. |
| **Split** | Part cash, the rest by M-Pesa prompt or typed code. |

A code can only be used once, ever. The receipt appears when the sale is paid.

## Receipts

The receipt shows your business name, address, KRA PIN and message (set by the owner in Settings), every item, VAT, how it was paid and a barcode.

- **Print receipt** prints only the receipt, sized for 80mm or 58mm paper (choose once, it is remembered).
- Reprints from Transactions are marked **COPY**. Refunds print as a refund slip.
- **Scanning a receipt's barcode** at the till opens that sale: a saved one goes back into the order, a paid one shows its receipt.

## Refunds, discounts and cancelling

A cashier asks; a manager or the owner approves on the **Today** screen (a red number shows how many are waiting). Nobody approves their own request, except the owner.

- **Refund:** Transactions, open the sale, **Request refund**, choose cash from the till or M-Pesa. Cash refunds come out of an open till. M-Pesa refunds are recorded here and sent from the M-Pesa portal.
- **Discount:** on an unpaid sale before any payment, **Ask for discount**.
- **Cancel:** on an unpaid sale with no payments, **Ask to cancel**.

## Managers

- **Today:** takings split by cash and M-Pesa, unpaid tabs by age, best sellers, sales per cashier, every till count with its shortage or excess, requests waiting for you, and typed M-Pesa codes to check against your statement (**Found it** or **Not found**).
- **Inventory:** stock in this branch, low stock alerts, **Receive delivery**, **Count** (stock take with a reason), reorder levels, adding and editing products, and each product's history.
- **Adding products by scanning:** on Inventory, scan a bottle. If it is new, **Add product** opens with the barcode filled in: type the name, category, size and price, then **Save**. If it is already in stock, it opens for editing. At the till, a manager or owner who scans an unknown bottle gets the same form, and the saved product goes straight into the sale. Cashiers are told to ask a manager. Scanning again while the form is open replaces the barcode, so a double scan does no harm.
- **Staff:** see who works where.

## Owners

Everything a manager can do in every branch, plus:

- **Branches:** compare every branch for any day, switch branch from the top bar.
- **Staff:** add people with a username and PIN, change roles and branches, set a new PIN, switch someone off. Changes sign that person out everywhere at once.
- **Settings:**
  - **Business:** the name, registered name, phone, email, address, KRA PIN and receipt message printed on receipts, and the VAT rate (0 if you are not VAT registered).
  - **M-Pesa:** your own Paybill or Till and Daraja keys. **Test connection** checks them. Leave it switched off to keep the simulation while training.
  - **Billing:** your plan, what you have used of it, what you owe, and every invoice from Flarehub.
  - **Devices:** every phone, tablet and computer signed in. Sign out one you do not recognise.
  - **Activity:** everything that changed in the business, newest first. It cannot be edited.
  - **Exports:** sales, items sold, payments, stock and products as CSV for Excel or your accountant.

## If selling is paused

The shop has been suspended or its subscription has ended, usually because an invoice is overdue. Staff can still sign in. The owner sees why under Settings, Billing. Contact Flarehub to settle it, and selling starts again straight away.
