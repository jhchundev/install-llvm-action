import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as io from "@actions/io";
import * as tc from "@actions/tool-cache";
import * as https from "https";
import * as path from "path";

export interface Options {
  version: string;
  arch: string | null;
  forceUrl: string | null;
  directory: string | null;
  cached: boolean;
  mirrorUrl: string | null;
  auth: string | null;
  env: boolean;
}

function getRequiredInput(name: string): string {
  const value = core.getInput(name).trim();
  if (value !== "") {
    return value;
  } else {
    throw new Error(`'${name}' input must be provided as a non-empty string`);
  }
}

function getOptionalInput(name: string): string | null {
  const value = core.getInput(name).trim();
  if (value !== "") {
    return value;
  } else {
    return null;
  }
}

export function getOptions(): Options {
  return {
    version: getRequiredInput("version"),
    arch: getOptionalInput("arch"),
    forceUrl: getOptionalInput("force-url"),
    directory: getOptionalInput("directory"),
    cached: getOptionalInput("cached")?.toLowerCase() === "true",
    mirrorUrl: getOptionalInput("mirror-url"),
    auth: getOptionalInput("auth"),
    env: getOptionalInput("env")?.toLowerCase() === "true",
  };
}

//================================================
// GitHub API
//================================================

interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  assets: GithubReleaseAsset[];
}

function githubGet(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN;
    const options: https.RequestOptions = {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "install-llvm-action",
        ...(token ? { Authorization: `token ${token}` } : {}),
      },
    };
    https
      .get(url, options, res => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error(`Failed to parse GitHub API response from ${url}`));
            }
          } else {
            reject(new Error(`GitHub API returned ${res.statusCode} for ${url}`));
          }
        });
      })
      .on("error", reject);
  });
}

//================================================
// Asset Patterns
//================================================

const ASSET_PATTERNS: [string, string, RegExp][] = [
  ["darwin", "arm64", /^((clang\+llvm-.+-arm64-apple-(darwin|macos).*)|(LLVM-.*-macOS-ARM64))\.tar\.xz$/],
  ["darwin", "x64", /^((clang\+llvm-.+-x86_64-apple-(darwin|macos).*)|(LLVM-.*-macOS-X64))\.tar\.xz$/],
  ["linux", "arm64", /^((clang\+llvm-.+-aarch64-linux-gnu.*)|(LLVM-.+-Linux-ARM64))\.tar\.xz$/],
  ["linux", "x64", /^((clang\+llvm-.+-x86_64-linux-gnu-?ubuntu.*)|(LLVM-.+-Linux-X64))\.tar\.xz$/],
  ["win32", "arm64", /^LLVM-.+-woa64\.exe$/],
  ["win32", "x64", /^LLVM-.+-win64\.exe$/],
];

function findMatchingAsset(assets: GithubReleaseAsset[], os: string, arch: string): GithubReleaseAsset | undefined {
  return assets.find(asset =>
    ASSET_PATTERNS.some(
      ([patOs, patArch, pattern]) =>
        patOs === os && patArch === arch && !/rc\d+/.test(asset.name) && pattern.test(asset.name),
    ),
  );
}

//================================================
// Version
//================================================

function parseVersionNumber(version: string): number | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match) {
    const [, major, minor, patch] = match.map(Number);
    return major * 100_000_000 + minor * 100_000 + patch;
  }
  return null;
}

async function resolveAsset(
  version: string,
  os: string,
  arch: string,
): Promise<{ specificVersion: string; downloadUrl: string }> {
  const isExact = /^\d+\.\d+\.\d+$/.test(version);

  if (isExact) {
    let release: GithubRelease;
    try {
      release = (await githubGet(
        `https://api.github.com/repos/llvm/llvm-project/releases/tags/llvmorg-${version}`,
      )) as GithubRelease;
    } catch {
      throw new Error(`LLVM version ${version} not found in GitHub releases`);
    }

    const asset = findMatchingAsset(release.assets, os, arch);
    if (!asset) {
      throw new Error(
        `No prebuilt binary found for LLVM ${version} on platform (os=${os}, arch=${arch}). ` +
          `The release exists but may not include a binary for this platform.`,
      );
    }

    return { specificVersion: version, downloadUrl: asset.browser_download_url };
  }

  // Partial version (e.g. "17" or "17.0"): search releases for the latest matching X.Y.Z
  const versionPrefix = `${version}.`;
  let bestVersion: string | null = null;
  let bestVersionNum = -1;
  let bestUrl: string | null = null;
  const targetMajor = parseInt(version.split(".")[0], 10);

  for (let page = 1; page <= 10; page++) {
    const releases = (await githubGet(
      `https://api.github.com/repos/llvm/llvm-project/releases?per_page=100&page=${page}`,
    )) as GithubRelease[];

    if (!releases.length) break;

    for (const release of releases) {
      const match = /^llvmorg-(\d+\.\d+\.\d+)$/.exec(release.tag_name);
      if (!match) continue;

      const releaseVersion = match[1];
      if (!releaseVersion.startsWith(versionPrefix) && releaseVersion !== version) continue;

      const versionNum = parseVersionNumber(releaseVersion);
      if (!versionNum || versionNum <= bestVersionNum) continue;

      const asset = findMatchingAsset(release.assets, os, arch);
      if (asset) {
        bestVersion = releaseVersion;
        bestVersionNum = versionNum;
        bestUrl = asset.browser_download_url;
      }
    }

    // Stop paginating once we've passed releases older than the target major version
    const lastRelease = releases[releases.length - 1];
    const lastMatch = /^llvmorg-(\d+\.\d+\.\d+)$/.exec(lastRelease.tag_name);
    if (lastMatch) {
      const lastMajor = parseInt(lastMatch[1].split(".")[0], 10);
      if (lastMajor < targetMajor - 1) break;
    }
  }

  if (!bestVersion || !bestUrl) {
    throw new Error(
      `No matching LLVM release found for version '${version}' on platform (os=${os}, arch=${arch}). ` +
        `Check that the version exists and has prebuilt binaries for this platform.`,
    );
  }

  return { specificVersion: bestVersion, downloadUrl: bestUrl };
}

//================================================
// Asset
//================================================

export interface Asset {
  readonly specificVersion: string;
  readonly url: string;
}

export async function getAsset(os: string, options: Options): Promise<Asset> {
  const info = { os: process.platform, arch: process.arch };
  console.log(`NodeJS process info = ${JSON.stringify(info)}`);

  if (options.forceUrl) {
    console.log("Using asset specified by `force-url` option.");
    return { specificVersion: options.version, url: options.forceUrl };
  }

  const arch = (options.arch ?? process.arch) || "x64";
  console.log(`Resolving LLVM asset via GitHub API (os=${os}, arch=${arch}, version=${options.version})...`);

  const { specificVersion, downloadUrl } = await resolveAsset(options.version, os, arch);

  let url: string;
  if (options.mirrorUrl) {
    const base = `https://github.com/llvm/llvm-project/releases/download/llvmorg-${specificVersion}`;
    const assetPath = downloadUrl.startsWith(base)
      ? downloadUrl.slice(base.length)
      : `/${path.basename(downloadUrl)}`;
    url = `${options.mirrorUrl}${assetPath}`;
  } else {
    url = downloadUrl;
  }

  return { specificVersion, url };
}

//================================================
// Action
//================================================

const DEFAULT_NIX_DIRECTORY = "./llvm";
const DEFAULT_WIN32_DIRECTORY = "C:/Program Files/LLVM";

async function install(options: Options): Promise<void> {
  const os = process.platform;
  const { specificVersion, url } = await getAsset(os, options);
  core.setOutput("version", specificVersion);

  console.log(`Installing LLVM and Clang ${options.version} (${specificVersion})...`);
  console.log(`Downloading and extracting '${url}'...`);
  const archive = await tc.downloadTool(url, "", options.auth ?? undefined);

  let exit;
  if (os === "win32") {
    exit = await exec.exec("7z", ["x", archive, `-o${options.directory}`, "-y"]);
  } else {
    const directory = options.directory ?? "";
    await io.mkdirP(directory);
    exit = await exec.exec("tar", ["xf", archive, "-C", directory, "--strip-components=1"]);
  }

  if (exit !== 0) {
    throw new Error("Could not extract LLVM and Clang binaries.");
  }

  core.info(`Installed LLVM and Clang ${options.version} (${specificVersion})!`);
  core.info(`Install location: ${options.directory}`);
}

export async function run(options: Options): Promise<void> {
  if (!options.directory) {
    options.directory = process.platform === "win32" ? DEFAULT_WIN32_DIRECTORY : DEFAULT_NIX_DIRECTORY;
  }

  options.directory = path.resolve(options.directory);

  if (options.cached) {
    console.log(`Using cached LLVM and Clang ${options.version}...`);
  } else {
    await install(options);
  }

  const bin = path.join(options.directory, "bin");
  const lib = path.join(options.directory, "lib");

  core.addPath(bin);

  core.exportVariable("LLVM_PATH", options.directory);

  const ld = process.env.LD_LIBRARY_PATH ?? "";
  core.exportVariable("LD_LIBRARY_PATH", `${lib}${path.delimiter}${ld}`);

  // Ensure system libraries are first on ARM64 macOS to avoid issues with Apple's libc++ being weird.
  // https://discourse.llvm.org/t/apples-libc-now-provides-std-type-descriptor-t-functionality-not-found-in-upstream-libc/73881/5
  const dyld = process.env.DYLD_LIBRARY_PATH;
  let dyldPrefix = "";
  if (process.platform === "darwin" && process.arch === "arm64") {
    dyldPrefix = `/usr/lib${path.delimiter}`;
  }

  core.exportVariable("DYLD_LIBRARY_PATH", `${dyldPrefix}${lib}${path.delimiter}${dyld}`);

  if (options.env) {
    core.exportVariable("CC", path.join(options.directory, "bin", "clang"));
    core.exportVariable("CXX", path.join(options.directory, "bin", "clang++"));
  }
}
