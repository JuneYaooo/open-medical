// v1 remains byte-for-byte available for historical report reproduction.
const args = process.argv.slice(2);
const at = args.indexOf("--protocol");
const version = at < 0 ? "v2" : args[at + 1];
if (!["v1", "v2"].includes(version))
  throw new Error("--protocol must be v1 or v2");
await import(`./evaluate-learning-${version}.mjs`);
