import express from "express";
import path from "node:path";

const app = express();
const port = Number(process.env.UI_PORT || 3002);
const publicDirectory = path.join(process.cwd(), "apps", "verification-ui");

app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});
app.use(express.static(publicDirectory));
app.get("/", (_req, res) => res.sendFile(path.join(publicDirectory, "index.html")));

app.listen(port, () => {
  console.log(`Verification UI listening on http://localhost:${port}`);
});
