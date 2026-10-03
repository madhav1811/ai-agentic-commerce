import { config } from "./config.js";
import { reloadEnv } from "./load-env.js";
import { CheckoutService } from "./checkout-service.js";
import { createServer } from "./server.js";

const service = new CheckoutService();
const app = createServer(service);

// `kill -HUP <pid>` re-reads .env and swaps in the Razorpay keys, so rotated
// keys can be fixed without a restart (which would lose in-memory holds).
process.on("SIGHUP", () => {
  reloadEnv();
  config.razorpay.keyId = process.env.RAZORPAY_KEY_ID ?? config.razorpay.keyId;
  config.razorpay.keySecret = process.env.RAZORPAY_KEY_SECRET ?? config.razorpay.keySecret;
  service.reloadRazorpayKeys(config.razorpay);
  console.log("🔑 reloaded Razorpay keys from .env");
});

app.listen(config.port, () => {
  console.log(`ScaleraiBazaar catalog-server listening on http://localhost:${config.port}`);
  console.log(`  catalog:    GET  http://localhost:${config.port}/catalog`);
  console.log(`  checkout:   POST http://localhost:${config.port}/checkout`);
  console.log(`  dashboard:       http://localhost:${config.port}/dashboard`);
  console.log(`  payment mode: ${config.paymentMode}`);
  console.log(`  pid: ${process.pid} (kill -HUP ${process.pid} reloads Razorpay keys from .env)`);
  if (config.razorpay.keyId === "rzp_test_placeholder") {
    console.warn(
      "⚠️  RAZORPAY_KEY_ID is not set — every checkout will fail with payment_failed. " +
        "Copy .env.example to .env at the repo root and add your test-mode keys."
    );
  }
});
