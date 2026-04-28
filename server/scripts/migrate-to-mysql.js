const path = require("path");
const { initSchema, one } = require("../db");
const { importFromLegacySqlite, importBotsFromTxt, seedIfEmpty } = require("../legacy-import");

async function main() {
  const sqlitePath = process.env.LEGACY_SQLITE_PATH || path.join(__dirname, "..", "app.db");
  console.log("[mysql] init schema...");
  await initSchema();

  console.log("[mysql] import legacy sqlite if present...");
  await importFromLegacySqlite(sqlitePath);

  console.log("[mysql] import bots txt if needed...");
  await importBotsFromTxt(false);

  console.log("[mysql] seed fallback data if empty...");
  await seedIfEmpty();

  const users = await one("SELECT COUNT(*) AS c FROM users");
  const bots = await one("SELECT COUNT(*) AS c FROM bots");
  console.log(`[mysql] done. users=${Number(users?.c || 0)}, bots=${Number(bots?.c || 0)}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[mysql] migration failed:", e);
    process.exit(1);
  });
