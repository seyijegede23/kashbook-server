// GET /i/:token — public, no auth. Renders an invoice that the merchant
// shared with a customer. Returns text/html.
const router = require("express").Router();
const prisma = require("../utils/db");
const {
  buildInvoiceHtml,
  deriveInvoicePaymentBlock,
  buildQrDataUrl,
  buildInvoiceNotFoundHtml,
} = require("../utils/invoiceHtml");

router.get("/i/:token", async (req, res) => {
  try {
    const link = await prisma.invoiceShareLink.findUnique({
      where: { token: req.params.token },
      include: {
        invoice: {
          include: {
            business: true,
            customer: { select: { id: true, name: true, phone: true } },
            items: true,
            payments: { orderBy: { date: "asc" } },
          },
        },
      },
    });

    if (!link || !link.invoice) {
      res.status(404).type("html").send(buildInvoiceNotFoundHtml());
      return;
    }

    const { invoice } = link;
    const business = invoice.business;
    const customer = invoice.customer;
    const payment = deriveInvoicePaymentBlock(business);

    const base = process.env.PUBLIC_BASE_URL ||
      `${req.protocol}://${req.get("host")}`;
    const shareUrl = `${base}/i/${link.token}`;
    const qrDataUrl = await buildQrDataUrl(shareUrl);

    const html = buildInvoiceHtml({
      invoice,
      business,
      customer,
      payment,
      shareUrl,
      qrDataUrl,
    });

    res.type("html").send(html);
  } catch (err) {
    console.error("[public invoice] render error:", err);
    res.status(500).type("html").send(buildInvoiceNotFoundHtml());
  }
});

module.exports = router;
