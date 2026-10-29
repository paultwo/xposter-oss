const command = process.env.WRANGLER_COMMAND ?? "";
const refused =
  command === "deploy" || command === "versions upload" || command === "dev";
if (!refused) {
  process.exit(0);
}

console.error(
  "Refusing to deploy the committed wrangler.jsonc. That file is a placeholder and its worker name is x-poster-unconfigured. Copy wrangler.local.jsonc.example to wrangler.local.jsonc, replace the placeholders, and run npm run deploy.",
);
process.exit(1);
