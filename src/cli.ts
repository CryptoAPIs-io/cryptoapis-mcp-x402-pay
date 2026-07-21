import { startX402Server } from "./server.js";

async function main() {
    await startX402Server();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
