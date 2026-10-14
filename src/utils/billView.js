// A bill as a client receives it (chart of accounts release 2, 2026-10-13).
// The bills routes (routes/bills.js) and the sync bundle (routes/sync.js) send
// every bill through publicBill; a member who may not open bills but sees the
// bank rows or the reports gets booksOnlyBill instead.
const { toKobo } = require("./money");
const { dayKey } = require("./books");

// A bill's payments, oldest first, with the bill wherever one is read:
// prisma.businessDebt.findMany({ ..., include: BILL_INCLUDE }).
// A restock's stock lines (release 3) come with it too, so the sync bundle
// carries them as the bills routes do.
const BILL_INCLUDE = Object.freeze({
  payments: { orderBy: [{ date: "asc" }, { createdAt: "asc" }] },
  items: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] },
});

// Amounts are worked in kobo (whole numbers) and stored in naira.
const naira = (kobo) => kobo / 100;

// The Lagos day of a date, "YYYY-MM-DD" as the books read it (books.js
// dayKey), or null for none. Read through a Date, so that text in ISO form
// gives the Lagos day too: dayKey keeps the first ten characters of text,
// which for an ISO time is its day in UTC.
const lagosDayOf = (v) => (v == null || v === "" ? null : dayKey(new Date(v)) || null);

// A payment typed in for a day is kept at midnight UTC on that day (the app
// sends the day, "YYYY-MM-DD", and routes/bills.js reads it as a Date), which
// is the same day in Lagos. The date `v` as such a payment carries it, on
// the same Lagos day, or null for none.
const asTypedDay = (v) => {
  const day = lagosDayOf(v);
  return day ? new Date(`${day}T00:00:00.000Z`) : null;
};

// The row as it is, the names the app's form uses, and its payments oldest
// first.
function publicBill(row) {
  if (!row || typeof row !== "object") return row;
  const payments = Array.isArray(row.payments)
    ? [...row.payments].sort((a, b) => new Date(a.date) - new Date(b.date) || new Date(a.createdAt) - new Date(b.createdAt))
    : [];
  const amountK = toKobo(row.originalAmount);
  const balanceK = toKobo(row.remainingAmount);
  return {
    ...row,
    vendorName: row.name,
    amount: naira(amountK),
    amountPaid: naira(amountK - balanceK),
    balance: naira(balanceK),
    payments: payments.map((p) => ({ ...p })),
  };
}

// A bill as the books read it, for a member who sees the bank rows or the
// reports but may not open bills (canManagePayables): its amounts, dates,
// accounts and its payments, never the supplier, the bill number, the notes
// or who made it. A debit that paid a bill stops counting on its own
// (books.js isDebitMatched) and the payment counts instead, so a phone with
// the debit but not the bill would count less spending than the server's
// reports. The Bills screens stay closed to these members.
//
// `seen` says what else the member sees: { canSeeBank: true } when they see
// the KashBook account's rows (canViewBalance), so they have the debits
// themselves; then a payment from that account says so (method "bank") and
// names its debit (transactionId), which their phone shows beside the debit.
// Anyone else's bank rows are withheld (routes/sync.js), and such a payment
// would hand them its debit: its id, and the very moment the money left. To
// them it reads as a transfer (which it was) typed in for the same Lagos day:
// method "transfer", no debit named, dated as asTypedDay dates it. Every
// other payment is sent as it is. The books read a bill payment's amount,
// its Lagos day and whether it is outside the books (books.js bookEvents),
// never its method, its link or its time of day, so their totals are the
// same. Anything but that object, such as the index that Array.prototype.map
// passes in bills.map(booksOnlyBill), sees no bank rows.
function booksOnlyBill(row, seen) {
  const b = publicBill(row);
  if (!b || typeof b !== "object") return b;
  const bank = !!seen && typeof seen === "object" && seen.canSeeBank === true;
  return {
    id: b.id,
    businessId: b.businessId,
    accountId: b.accountId,
    receivedViaAccountId: b.receivedViaAccountId,
    billDate: b.billDate,
    dueDate: b.dueDate,
    originalAmount: b.originalAmount,
    remainingAmount: b.remainingAmount,
    amount: b.amount,
    amountPaid: b.amountPaid,
    balance: b.balance,
    status: b.status,
    estimated: b.estimated,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    name: "",
    vendorName: "",
    billNumber: null,
    note: null,
    payments: b.payments.map((p) => {
      // From the KashBook account, to a member who may not see its rows.
      const withheld = !bank && p.method === "bank";
      return {
        id: p.id,
        billId: p.billId,
        amount: p.amount,
        date: withheld ? asTypedDay(p.date) : p.date,
        method: withheld ? "transfer" : p.method,
        paidThroughAccountId: p.paidThroughAccountId,
        transactionId: bank ? p.transactionId : null,
        estimated: p.estimated,
        outsideBooks: p.outsideBooks,
        note: null,
        createdAt: p.createdAt,
      };
    }),
  };
}

// A whole bill for whoever may open bills: as publicBill, except that a
// member who does not see the KashBook account's rows (canViewBalance; owners
// do) gets no debit id on its payments (owner's call, 2026-10-13). They
// still see that a payment came from the KashBook account, how much and on
// which day: that is part of the bill. The id would only point at bank rows
// withheld from them.
// A payment from the KashBook account carries the debit's own time: it goes
// out on its Lagos day only (asTypedDay), as a typed payment is kept.
function billFor(row, { canSeeBank }) {
  const b = publicBill(row);
  if (canSeeBank === true || !b || typeof b !== "object" || !Array.isArray(b.payments)) return b;
  return {
    ...b,
    payments: b.payments.map((p) =>
      p.transactionId || p.method === "bank" ? { ...p, transactionId: null, date: asTypedDay(p.date) || p.date } : p,
    ),
  };
}

module.exports = { BILL_INCLUDE, publicBill, booksOnlyBill, billFor };
