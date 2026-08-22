import express from "express";
import cors from "cors";
import verificationRoutes from "./routes";

const app = express();
const port = Number(process.env.MOCK_PROVIDER_PORT || 4001);

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.get("/health", (_req, res) => res.json({ status: "ok", service: "mock-verification-server" }));
app.use("/v1/verify", verificationRoutes);

app.listen(port, () => console.log(`Mock verification server listening on http://localhost:${port}`));
