import { config } from "./config.js";
import { CheckoutService } from "./checkout-service.js";
import { createServer } from "./server.js";

const service = new CheckoutService();
const app = createServer(service);

app.listen(config.port, () => {
  console.log(`ScaleraiBazaar catalog-server listening on http://localhost:${config.port}`);
  console.log(`  catalog:    GET  http://localhost:${config.port}/catalog`);
  console.log(`  checkout:   POST http://localhost:${config.port}/checkout`);
  console.log(`  dashboard:       http://localhost:${config.port}/dashboard`);
  console.log(`  payment mode: ${config.paymentMode}`);
  if (config.razorpay.keyId === "rzp_test_placeholder") {
    console.warn(
      "⚠️  RAZORPAY_KEY_ID is not set — every checkout will fail with payment_failed. " +
        "Copy .env.example to .env at the repo root and add your test-mode keys."
    );
  }
});
