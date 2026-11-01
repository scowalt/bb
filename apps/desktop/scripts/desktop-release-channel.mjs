const DESKTOP_RELEASE_CHANNEL_ENV_NAME = "BB_DESKTOP_RELEASE_CHANNEL";
const DESKTOP_UPDATE_REPOSITORY_ENV_NAME = "BB_DESKTOP_UPDATE_REPOSITORY";
const DEFAULT_DESKTOP_UPDATE_REPOSITORY = "get-bb/bb";
const DESKTOP_UPDATE_REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/u;

export function resolveDesktopReleaseChannel(env) {
  const rawChannel = env[DESKTOP_RELEASE_CHANNEL_ENV_NAME]?.trim();
  if (rawChannel === undefined || rawChannel.length === 0) {
    return "latest";
  }
  if (rawChannel === "latest" || rawChannel === "nightly") {
    return rawChannel;
  }

  throw new Error(
    `${DESKTOP_RELEASE_CHANNEL_ENV_NAME} must be latest or nightly, got ${rawChannel}.`,
  );
}

export function resolveDesktopUpdateRepository(env) {
  const rawRepository = env[DESKTOP_UPDATE_REPOSITORY_ENV_NAME]?.trim();
  if (rawRepository === undefined || rawRepository.length === 0) {
    return DEFAULT_DESKTOP_UPDATE_REPOSITORY;
  }
  if (DESKTOP_UPDATE_REPOSITORY_PATTERN.test(rawRepository)) {
    return rawRepository;
  }

  throw new Error(
    `${DESKTOP_UPDATE_REPOSITORY_ENV_NAME} must be a GitHub owner/name, got ${rawRepository}.`,
  );
}

export function resolveDesktopBuildPlatform(nodePlatform) {
  if (nodePlatform === "darwin") {
    return "macos";
  }
  if (nodePlatform === "linux") {
    return "linux";
  }
  if (nodePlatform === "win32") {
    return "windows";
  }

  throw new Error(
    `Desktop builds support darwin, linux, and win32 only, got ${nodePlatform}.`,
  );
}

export function createDesktopReleaseConfig(channel) {
  if (channel === "nightly") {
    return {
      appId: "dev.bb.desktop.nightly",
      applicationName: "bb Nightly",
      artifactName: "bb-nightly-${version}-${arch}.${ext}",
      iconFileName: "icon-nightly.png",
      // The Linux binary name must differ from stable so both channels can be
      // installed at once without one shadowing the other on PATH.
      linuxExecutableName: "bb-nightly",
      macIconPath: "assets/icon-nightly.icns",
      releaseTag: "desktop-nightly",
      windowsInstallName: "bb-nightly",
      updateMetadataFileNames: {
        linux: "nightly-linux.yml",
        macos: "nightly-mac.yml",
        windows: "nightly.yml",
      },
    };
  }

  return {
    appId: "dev.bb.desktop",
    applicationName: "bb",
    artifactName: "${productName}-${version}-${arch}.${ext}",
    iconFileName: "icon.png",
    linuxExecutableName: "bb",
    macIconPath: "assets/icon.icns",
    releaseTag: "desktop-latest",
    windowsInstallName: "bb",
    updateMetadataFileNames: {
      linux: "latest-linux.yml",
      macos: "latest-mac.yml",
      windows: "latest.yml",
    },
  };
}

export function createDesktopUpdateReleaseBaseUrl(repository, releaseTag) {
  return `https://github.com/${repository}/releases/download/${releaseTag}/`;
}
