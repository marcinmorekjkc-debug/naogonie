// create-admin.js — jednorazowy skrypt do utworzenia konta administratora panelu.
// Użycie: node create-admin.js <login> <haslo>
require("dotenv").config();
const bcrypt = require("bcryptjs");
const db = require("./db");

async function main() {
    const [, , username, password] = process.argv;
    if (!username || !password) {
        console.error("Użycie: node create-admin.js <login> <haslo>");
        process.exit(1);
    }
    const existing = await db.findAdminUser(username);
    if (existing) {
        console.error(`Administrator "${username}" już istnieje.`);
        process.exit(1);
    }
    const hash = await bcrypt.hash(password, 10);
    await db.createAdminUser(username, hash);
    console.log(`Utworzono administratora: ${username}`);
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
