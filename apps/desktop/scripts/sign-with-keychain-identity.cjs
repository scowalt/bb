const { createRequire } = require("node:module");

const requireFromElectronBuilder = createRequire(
  require.resolve("electron-builder"),
);
const { sign } = requireFromElectronBuilder(
  "app-builder-lib/out/codeSign/macCodeSign",
);

function readEnvValue(name) {
  return process.env[name]?.trim() ?? "";
}

module.exports = async function signWithKeychainIdentity(options) {
  const identity = readEnvValue("BB_DESKTOP_SIGNING_IDENTITY");
  if (identity.length === 0) {
    throw new Error(
      "BB_DESKTOP_SIGNING_IDENTITY must name the keychain signing identity.",
    );
  }
  const keychain = readEnvValue("BB_DESKTOP_SIGNING_KEYCHAIN");

  await sign({
    ...options,
    identity,
    keychain: keychain.length > 0 ? keychain : options.keychain,
    timestamp: "none",
  });
};
