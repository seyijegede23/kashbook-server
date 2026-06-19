const bcrypt = require("@node-rs/bcrypt"); // native (off-thread) — verify() replaces compare()
const prisma = require("./db");

const PIN_REGEX = /^\d{4}$/;
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;

/**
 * Verify a transaction PIN for the given user.
 * Increments failure counter on miss, locks for 15 min after 5 misses,
 * resets counter on success.
 *
 * Returns { ok: true } on success or
 * { ok: false, error, status, code } on failure.
 *
 * Codes: NO_PIN | PIN_WRONG | PIN_LOCKED | (none for shape/length errors)
 */
async function verifyTransactionPin(userId, pin) {
  if (!PIN_REGEX.test(String(pin || ""))) {
    return { ok: false, error: "PIN must be 4 digits", status: 400 };
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.transactionPin) {
    return { ok: false, error: "No transaction PIN set", status: 400, code: "NO_PIN" };
  }
  if (user.transactionPinLockedUntil && user.transactionPinLockedUntil > new Date()) {
    return {
      ok: false,
      error: "Too many failed attempts. Try again in a few minutes.",
      status: 423,
      code: "PIN_LOCKED",
    };
  }
  const match = await bcrypt.verify(String(pin), user.transactionPin);
  if (!match) {
    // Atomic increment — concurrent wrong guesses can't all read the same count
    // and write back 1, which would let an attacker evade the lock-out.
    const { transactionPinFailedCount: failed } = await prisma.user.update({
      where: { id: userId },
      data: { transactionPinFailedCount: { increment: 1 } },
      select: { transactionPinFailedCount: true },
    });
    if (failed >= PIN_MAX_ATTEMPTS) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          transactionPinFailedCount: 0,
          transactionPinLockedUntil: new Date(Date.now() + PIN_LOCK_MS),
        },
      });
      return {
        ok: false,
        error: "Too many wrong PINs. Locked for 15 minutes.",
        status: 423,
        code: "PIN_LOCKED",
      };
    }
    return {
      ok: false,
      error: `Wrong PIN. ${PIN_MAX_ATTEMPTS - failed} attempt(s) left.`,
      status: 401,
      code: "PIN_WRONG",
    };
  }
  if (user.transactionPinFailedCount || user.transactionPinLockedUntil) {
    await prisma.user.update({
      where: { id: userId },
      data: { transactionPinFailedCount: 0, transactionPinLockedUntil: null },
    });
  }
  // verifiedAt enables the AML pipeline to enforce a freshness window for
  // step-up re-PIN on large transfers.
  return { ok: true, verifiedAt: Date.now() };
}

module.exports = { verifyTransactionPin, PIN_REGEX };
