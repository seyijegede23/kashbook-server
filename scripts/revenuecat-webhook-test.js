/**
 * RevenueCat webhook: grant, revoke, and the pinned review account.
 * Runs the real router against a stubbed prisma, no database, no network.
 *
 *   node scripts/revenuecat-webhook-test.js
 */
process.env.REVENUECAT_WEBHOOK_AUTH = "secret-for-test";
process.env.REVENUECAT_PINNED_USER_IDS = "pinned-1, pinned-2";

const Module = require("module");
const path = require("path");

// Stub the modules the router pulls in, before it is required.
const users = { "u-free": { id: "u-free", plan: "FREE" }, "u-pro": { id: "u-pro", plan: "PREMIUM" }, "pinned-1": { id: "pinned-1", plan: "PREMIUM" } };
const updates = [], audits = [], pushes = [];
const stubs = {
  [path.resolve(__dirname, "../src/utils/db.js")]: {
    user: {
      findFirst: async ({ where }) => { const ids = where.id.in; const hit = ids.map((i) => users[i]).find(Boolean); return hit ? { ...hit, expoPushToken: null, notificationsEnabled: true } : null; },
      update: async ({ where, data }) => { updates.push([where.id, data.plan]); users[where.id].plan = data.plan; },
    },
  },
  [path.resolve(__dirname, "../src/utils/audit.js")]: { audit: async (row) => { audits.push(row); } },
  [path.resolve(__dirname, "../src/utils/pushNotification.js")]: { pushTo: async (id) => { pushes.push(id); } },
};
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (parent && parent.filename) {
    const full = path.resolve(path.dirname(parent.filename), request) + (request.endsWith(".js") ? "" : ".js");
    if (stubs[full]) return stubs[full];
  }
  return origLoad.call(this, request, parent, ...rest);
};

const express = require("express");
const router = require("../src/routes/revenuecat");
const app = express();
app.use(express.json());
app.use("/webhooks/revenuecat", router);

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => { if (ok) { passed++; console.log("  ok  " + name); } else { failed++; console.log("  FAIL " + name + (extra ? " — " + extra : "")); } };
const tick = () => new Promise((r) => setTimeout(r, 20)); // handler acks 200 then works async

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/webhooks/revenuecat`;
  const send = (event, auth = "secret-for-test") => fetch(base, { method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body: JSON.stringify({ event }) });

  let r = await send({ type: "INITIAL_PURCHASE", app_user_id: "u-free" }, "wrong");
  check("wrong auth is rejected", r.status === 401);

  r = await send({ type: "INITIAL_PURCHASE", app_user_id: "u-free", product_id: "kashbook_pro_monthly" }); await tick();
  check("INITIAL_PURCHASE grants Pro", r.status === 200 && users["u-free"].plan === "PREMIUM");
  check("grant is audited", audits.some((a) => a.action === "SUBSCRIPTION_GRANTED" && a.resourceId === "u-free"));
  check("grant sends the welcome push", pushes.includes("u-free"));

  r = await send({ type: "EXPIRATION", app_user_id: "u-free" }); await tick();
  check("EXPIRATION revokes an ordinary account", users["u-free"].plan === "FREE");
  check("revoke is audited", audits.some((a) => a.action === "SUBSCRIPTION_EXPIRED" && a.resourceId === "u-free"));

  const before = updates.length;
  r = await send({ type: "EXPIRATION", app_user_id: "pinned-1", product_id: "kashbook_pro_yearly" }); await tick();
  check("EXPIRATION on a pinned account keeps Pro", users["pinned-1"].plan === "PREMIUM" && updates.length === before);
  check("ignored revoke is audited", audits.some((a) => a.action === "SUBSCRIPTION_REVOKE_IGNORED" && a.resourceId === "pinned-1" && a.metadata.reason === "pinned"));

  users["pinned-1"].plan = "FREE";
  r = await send({ type: "RENEWAL", app_user_id: "pinned-1" }); await tick();
  check("a grant still applies to a pinned account", users["pinned-1"].plan === "PREMIUM");

  r = await send({ type: "EXPIRATION", app_user_id: "$RCAnonymousID:abc" }); await tick();
  check("anonymous ids are skipped", r.status === 200 && updates.length === before + 1);

  r = await send({ type: "CANCELLATION", app_user_id: "u-pro" }); await tick();
  check("CANCELLATION changes nothing", users["u-pro"].plan === "PREMIUM");

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
