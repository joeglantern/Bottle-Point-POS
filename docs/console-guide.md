# Console guide

For the Flarehub team, at `https://console.pos.flarehub.co.ke`. Sign in with your email and password. Five wrong passwords lock the account for 15 minutes.

Press **/** or **Ctrl K** anywhere to search for a client or an invoice.

## Roles

| Role | Can |
|---|---|
| **Super admin** | Everything, including adding and removing team members |
| **Support** | Add clients, edit their details, suspend and reactivate, reset an owner's PIN, sign a client out everywhere, notes, extend trials |
| **Billing** | Plans, subscriptions (plan, discount, agreed price, cancel), invoices, payments, the billing run, extend trials |

Everyone can read everything. Buttons you cannot use are greyed out and say who can.

## Overview

Monthly recurring revenue (and yearly), paying clients, what is owed and how much of it is overdue, money collected this month, revenue for the last 12 months (invoiced against collected), sales going through clients' tills, the plan mix, clients that need attention (past due, suspended, trials ending), and recent activity.

## Onboarding a client

**Clients, New client.**

1. **Business name** and **Web address**. The address fills in from the name (`Nyrolix` becomes `nyrolix`, so the shop lives at `nyrolix.pos.flarehub.co.ke`). Lowercase letters, digits and dashes. Some words are reserved (console, admin, www, and others).
2. **First branch** name.
3. **Owner** name and **username**. Leave the PIN empty and one is generated.
4. **Plan**: choose one, or **No plan yet, do not bill**. With a plan you can set the trial length; 0 starts billing straight away.

The next screen shows the owner's PIN **once**. Copy it and send it to the owner privately, together with their address and username. The address gets its HTTPS certificate within about a minute. The owner signs in and adds their own staff, products and branches.

## A client's page

- **Overview:** usage against the plan's limits, sales in the last 30 days, last sale, last sign in, what they owe, business details (edit with **Edit**) and their owners.
- **Subscription:** the plan and price as it applies to them, status, trial end, current period, and the estimate for the next invoice. **Change plan** (takes effect now; refused if they use more than the new plan allows, unless you change anyway), **Discount or agreed price**, **Extend trial**, **Cancel subscription** (now, or at the end of the period), **Resume**.
- **Invoices:** their invoices, and **New invoice** for a one off charge (setup, training, hardware). VAT is added.
- **People:** their staff, roles, branches and last sign in. **Reset PIN** for an owner (shown once, signs them out everywhere, clears a lockout). **Sign out everyone**.
- **Notes:** internal notes. The client never sees them.
- **Activity:** everything that happened to this client, by them and by us.

**Changing a client's name or web address:** Overview, Business details, **Edit**. Anyone in Support can change the name. Only super admins can change the **web address**, because it moves the shop: the new address gets its certificate and goes live within about a minute, and the old address forwards everyone to the new one, so bookmarks and home screen icons keep working. Staff stay signed in on the new address after one sign in there. A former address can be given to another client later; the live client always wins.

**Suspend** (top right) stops every till at once. Staff can still sign in and see why: the reason you type is shown to them. **Reactivate** brings them back (as past due if they still have an overdue invoice).

## Plans

**Plans, New plan.** Choose how it is priced, and the form shows only the fields that apply, with a live sentence of what clients will see:

| Model | Price |
|---|---|
| Flat fee | One amount a month or a year |
| Per branch | An optional base fee plus an amount for each open branch |
| Share of sales | A percentage of what the shop sells in the month, with a monthly minimum. Billed after the month. |
| One time licence | Paid once, never renews |

Also: limits on branches, staff and products (empty means no limit), trial days, and **Public** (switch off for negotiated deals only the team assigns). The code cannot change after creation. Price changes apply to future invoices only. A plan with clients cannot be deleted; **Archive** it so no new clients get it.

## Subscriptions and the billing run

**Subscriptions** lists every client's subscription with the next amount.

The billing run happens **every hour by itself**. **Run billing** does it now and first shows exactly what will happen. Each run:

- ends trials that have finished, and raises the first invoice (except share of sales, which is billed after the month)
- starts each new period and raises its invoice (due in 7 days)
- cancels subscriptions set to end at the period's end
- marks a client **past due** 7 days after an invoice's due date, and **suspends** them 21 days after it

Running it twice never bills anyone twice.

## Invoices and payments

**Invoices** has filters (open, overdue, paid, void, dates, search), totals for the filter (billed, collected, outstanding) and **Export CSV**.

On an invoice: **Record payment** (amount, method, reference such as the M-Pesa code, date received). Part payments are fine; overpaying is refused. When the last overdue invoice is paid, a past due or suspended client returns to active automatically. **Void** an open invoice with no payments. **Print or save as PDF** gives a clean A4 invoice.

## Team

**Team, Add someone** (super admins): name, email and role. A temporary password is shown once; they change it under **Account**. **Edit** changes the role or switches someone off (they are signed out everywhere). **New password** resets a forgotten one. You cannot switch off or demote yourself, and the last super admin is protected.

## Audit log

Everything the team, the shops and the system did, newest first, filterable by kind and date. Click a row for the details. Entries cannot be edited or deleted.

## Account

Your details and **Change password** (at least 10 characters). Changing it signs out your other devices.
